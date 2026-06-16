/**
 * Hook-run lifecycle + queue glue. Owns every Prisma write to `hook_runs` /
 * `hook_deliveries` and the BullMQ enqueue/cancel paths, so the processor only
 * has to stream and deliver.
 *
 * Durability model: one BullMQ job per run (`jobId = runId`). A crashed run is
 * recovered by BullMQ's stalled-job detection and resumed from `cursorOffset`;
 * on boot we also re-enqueue any non-terminal run so nothing is orphaned.
 */
import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  BadRequestError,
  ConflictError,
  type DeliveryStatus,
  type HookDelivery,
  type HookRun,
  type HookRunStatus,
  NotFoundError,
} from '@relay/core';
import { Queue } from 'bullmq';
import type {
  HookDelivery as DeliveryRow,
  HookRun as RunRow,
} from '@prisma/client';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { PrismaService } from '../common/prisma.service';
import { HookStoreService } from './hook-store.service';
import { DeliveryService, sleep } from './delivery.service';
import { RunRegistryService } from './run-registry.service';
import {
  HOOK_RUNS_QUEUE,
  type DeliveryOutcome,
  type HookRunJob,
} from './hooks.types';

const ACTIVE: HookRunStatus[] = ['queued', 'running', 'canceling'];
const TERMINAL: HookRunStatus[] = [
  'completed',
  'failed',
  'canceled',
  'interrupted',
];

@Injectable()
export class HookRunService implements OnModuleInit {
  private readonly logger = new Logger('HookRun');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: HookStoreService,
    private readonly registry: RunRegistryService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
    @InjectQueue(HOOK_RUNS_QUEUE) private readonly queue: Queue<HookRunJob>,
  ) {}

  /**
   * Re-send the failed deliveries of a run by re-POSTing their captured request
   * bodies to the hook's CURRENT destination. Works for every hook type
   * (replay / watch / cdc) — ideal after fixing a bad URL or a down endpoint.
   * A delivery that succeeds flips from failed → success (counters adjust).
   */
  async resendFailed(hookId: string, runId: string): Promise<HookRun> {
    const run = await this.getRunRow(runId);
    if (run.hookId !== hookId) throw new NotFoundError(`Run "${runId}" not found`);
    const hook = await this.store.resolve(hookId);
    const failed = await this.prisma.hookDelivery.findMany({
      where: { runId, status: 'failed' },
      orderBy: { sequence: 'asc' },
      take: 2000,
    });
    if (failed.length === 0) throw new BadRequestError('No failed deliveries to retry.');

    const signal = new AbortController().signal;
    for (const d of failed) {
      let body: unknown = null;
      if (d.requestBody) {
        try {
          body = JSON.parse(d.requestBody);
        } catch {
          body = d.requestBody;
        }
      }
      const idem = hook.destination.idempotency ? `${runId}:${d.sequence}` : undefined;
      const outcome = await this.delivery.send(
        body,
        hook.destination,
        hook.delivery,
        signal,
        idem,
      );
      await this.recordDelivery(
        runId,
        {
          sequence: d.sequence,
          rowIndex: d.rowIndex,
          rowCount: d.rowCount,
          rowKeys: d.rowKeysJson ? (JSON.parse(d.rowKeysJson) as unknown[]) : null,
        },
        outcome,
      );
      if (hook.delivery.minDelayMs) await sleep(hook.delivery.minDelayMs);
    }
    return this.getRun(hookId, runId);
  }

  /* ----- prepare (queue without sending) ----- */

  /**
   * Create a "draft" run so the UI shows the planned deliveries as queued the
   * moment a hook is created — before anything is sent. Replaces any prior
   * draft for the hook. Best-effort total so the timeline can render cells.
   */
  async prepare(
    hookId: string,
    opts: { onlyExisting?: boolean } = {},
  ): Promise<HookRun | null> {
    const hook = await this.store.get(hookId);
    // Drafts model a finite replay; watch hooks are live listeners, not drafts.
    if (hook.trigger.kind !== 'replay') return null;
    // Don't clobber an in-flight run with a draft.
    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ACTIVE } },
    });
    if (active) return null;

    const { count } = await this.prisma.hookRun.deleteMany({
      where: { hookId, status: 'draft' },
    });
    // On update we only refresh a draft that already existed — never add a
    // fresh draft to a hook that has already been run.
    if (opts.onlyExisting && count === 0) return null;

    const snapshotJson = await this.store.snapshotJson(hookId);
    const total = await this.computeTotal(snapshotJson).catch(() => null);
    const row = await this.prisma.hookRun.create({
      data: {
        id: randomUUID(),
        hookId,
        status: 'draft',
        configSnapshotJson: snapshotJson,
        totalCount: total,
      },
    });
    return this.toRun(row);
  }

  /* ----- start / resume / retry ----- */

  async start(
    hookId: string,
    opts: { resumeRunId?: string; runId?: string; retryFailedOf?: string } = {},
  ): Promise<HookRun> {
    await this.store.get(hookId); // 404 if the hook is gone

    if (opts.retryFailedOf) return this.retryFailed(hookId, opts.retryFailedOf);
    if (opts.resumeRunId) return this.resume(hookId, opts.resumeRunId);

    // Starting a prepared draft, or the hook's existing draft if any.
    const draft = opts.runId
      ? await this.getRunRow(opts.runId)
      : await this.prisma.hookRun.findFirst({
          where: { hookId, status: 'draft' },
        });
    if (draft && draft.hookId === hookId && draft.status === 'draft') {
      await this.ensureQueueReady();
      const row = await this.prisma.hookRun.update({
        where: { id: draft.id },
        data: { status: 'queued', startedAt: new Date() },
      });
      await this.enqueue(draft.id, hookId);
      return this.toRun(row);
    }

    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ACTIVE } },
    });
    if (active) {
      throw new ConflictError(
        'A run is already in progress for this hook. Cancel it before starting another.',
      );
    }

    // Resume the most recent paused/stopped run in place (one run per job)
    // rather than spawning a new one each time. A finished run starts fresh.
    const latest = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['paused', 'canceled', 'interrupted', 'failed'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (latest) return this.resume(hookId, latest.id);

    await this.ensureQueueReady();
    const id = randomUUID();
    const snapshotJson = await this.store.snapshotJson(hookId);
    const total = await this.computeTotal(snapshotJson).catch(() => null);
    const row = await this.prisma.hookRun.create({
      data: {
        id,
        hookId,
        status: 'queued',
        configSnapshotJson: snapshotJson,
        totalCount: total,
      },
    });
    await this.enqueue(id, hookId);
    return this.toRun(row);
  }

  /**
   * Re-send the rows that FAILED in this run, IN PLACE — the same run and the
   * same delivery cells are reused, so failed (red) rows flip to delivered
   * (green) on success. The config snapshot is refreshed to the hook's current
   * config so a fixed URL/headers/auth take effect. Resetting the cursor makes
   * the worker re-stream and re-send only the not-yet-settled (failed) rows;
   * already-delivered/skipped rows are skipped untouched.
   */
  private async retryFailed(hookId: string, runId: string): Promise<HookRun> {
    const run = await this.getRunRow(runId);
    if (run.hookId !== hookId)
      throw new NotFoundError(`Run "${runId}" not found`);
    if (!TERMINAL.includes(run.status as HookRunStatus)) {
      throw new ConflictError('Wait for the run to finish before retrying.');
    }
    const failedCount = await this.prisma.hookDelivery.count({
      where: { runId, status: 'failed' },
    });
    if (failedCount === 0)
      throw new BadRequestError('No failed rows to retry.');

    await this.ensureQueueReady();
    const updated = await this.prisma.hookRun.update({
      where: { id: runId },
      data: {
        status: 'queued',
        cursorOffset: 0,
        error: null,
        finishedAt: null,
        configSnapshotJson: await this.store.snapshotJson(hookId),
      },
    });
    await this.enqueue(runId, hookId);
    return this.toRun(updated);
  }

  /** Best-effort planned row count for a source, used to render the timeline. */
  private async computeTotal(snapshotJson: string): Promise<number | null> {
    const hook = this.store.resolveSnapshot(snapshotJson);
    if (hook.source.kind === 'table') {
      const src = hook.source;
      const page = await this.pool.withAdapter(
        src.connectionId,
        src.database,
        (a) =>
          a.browse({
            schema: src.schema,
            table: src.table,
            filters: src.filters,
            limit: 1,
            offset: 0,
          }),
      );
      return page.total;
    }
    const result = await this.pool.withAdapter(
      hook.source.connectionId,
      hook.source.database,
      (a) => a.query(hook.source.kind === 'query' ? hook.source.statement : ''),
    );
    return result.rows.length;
  }

  private async resume(hookId: string, runId: string): Promise<HookRun> {
    const row = await this.getRunRow(runId);
    if (row.hookId !== hookId)
      throw new NotFoundError(`Run "${runId}" not found`);
    const resumable: HookRunStatus[] = ['failed', 'canceled', 'paused', 'interrupted'];
    if (!resumable.includes(row.status as HookRunStatus)) {
      throw new ConflictError(
        `Run "${runId}" cannot be resumed (status: ${row.status}).`,
      );
    }
    await this.ensureQueueReady();
    // Resume the REMAINING rows with the hook's CURRENT config, so edits made
    // after the run started (e.g. fewer columns, a new endpoint) take effect.
    const reset = await this.prisma.hookRun.update({
      where: { id: runId },
      data: {
        status: 'queued',
        error: null,
        finishedAt: null,
        configSnapshotJson: await this.store.snapshotJson(hookId),
      },
    });
    await this.enqueue(runId, hookId);
    return this.toRun(reset);
  }

  private async enqueue(runId: string, hookId: string): Promise<void> {
    await this.queue.add(
      'run',
      { runId, hookId },
      { jobId: runId, removeOnComplete: true, removeOnFail: 500, attempts: 1 },
    );
  }

  /** Fail fast with a friendly message when Redis is unreachable. */
  private async ensureQueueReady(): Promise<void> {
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000),
        ),
      ]);
      return;
    } catch {
      throw new AppError(
        'CONNECTION_FAILED',
        'The job queue (Redis) is unavailable. Start it with `docker compose up -d redis` or set REDIS_URL.',
        503,
      );
    }
  }

  /* ----- cancel ----- */

  async cancel(hookId: string, runId: string): Promise<HookRun> {
    const row = await this.getRunRow(runId);
    if (row.hookId !== hookId)
      throw new NotFoundError(`Run "${runId}" not found`);
    if (TERMINAL.includes(row.status as HookRunStatus)) return this.toRun(row);

    const updated = await this.prisma.hookRun.update({
      where: { id: runId },
      data: { status: 'canceling' },
    });
    this.registry.abort(runId); // stop the in-flight fetch immediately
    await this.queue.remove(runId).catch(() => {}); // best-effort; worker also self-stops
    return this.toRun(updated);
  }

  /* ----- queries ----- */

  async listRuns(hookId: string, limit = 50): Promise<HookRun[]> {
    const rows = await this.prisma.hookRun.findMany({
      where: { hookId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toRun(r));
  }

  async getRun(hookId: string, runId: string): Promise<HookRun> {
    const row = await this.getRunRow(runId);
    if (row.hookId !== hookId)
      throw new NotFoundError(`Run "${runId}" not found`);
    return this.toRun(row);
  }

  async listDeliveries(
    runId: string,
    opts: {
      status?: 'success' | 'failed' | 'skipped';
      /** Inclusive sequence window — lets the UI page the timeline cheaply. */
      from?: number;
      to?: number;
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<HookDelivery[]> {
    const sequence =
      opts.from != null || opts.to != null
        ? {
            ...(opts.from != null ? { gte: opts.from } : {}),
            ...(opts.to != null ? { lte: opts.to } : {}),
          }
        : undefined;
    const rows = await this.prisma.hookDelivery.findMany({
      where: {
        runId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(sequence ? { sequence } : {}),
      },
      orderBy: { sequence: 'asc' },
      skip: opts.offset ?? 0,
      take: Math.min(opts.limit ?? 500, 2000),
    });
    return rows.map((r) => this.toDelivery(r));
  }

  /**
   * Mark sequences to skip. Best-effort: only effective while the sequence is
   * still queued (the worker checks the skip set before sending). Creates a
   * `skipped` delivery row for each sequence that has no delivery yet.
   */
  async skipDeliveries(runId: string, sequences: number[]): Promise<number> {
    const run = await this.getRunRow(runId);
    const batchSize = this.snapshotBatchSize(run.configSnapshotJson);
    const totalCount = run.totalCount;

    const existing = await this.prisma.hookDelivery.findMany({
      where: { runId, sequence: { in: sequences } },
      select: { sequence: true },
    });
    const taken = new Set(existing.map((e) => e.sequence));
    const fresh = [...new Set(sequences)].filter((s) => !taken.has(s));
    if (fresh.length === 0) return 0;

    // Compute the actual row count for each sequence. The last batch may be
    // smaller than batchSize when totalCount is not perfectly divisible.
    const lastSeq =
      totalCount != null ? Math.ceil(totalCount / batchSize) - 1 : null;
    const lastBatchSize =
      lastSeq != null && totalCount != null
        ? totalCount - lastSeq * batchSize
        : batchSize;

    const rowCountFor = (seq: number): number =>
      lastSeq != null && seq === lastSeq ? lastBatchSize : batchSize;

    const skippedRows = fresh.reduce((acc, s) => acc + rowCountFor(s), 0);

    await this.prisma.$transaction([
      this.prisma.hookDelivery.createMany({
        data: fresh.map((sequence) => ({
          id: randomUUID(),
          runId,
          sequence,
          rowIndex: sequence * batchSize,
          rowCount: rowCountFor(sequence),
          status: 'skipped',
          attempts: 0,
        })),
      }),
      this.prisma.hookRun.update({
        where: { id: runId },
        data: { skippedCount: { increment: skippedRows } },
      }),
    ]);
    return fresh.length;
  }

  /** Sequences explicitly skipped — the worker must not send these. */
  async skippedSequences(runId: string): Promise<Set<number>> {
    const rows = await this.prisma.hookDelivery.findMany({
      where: { runId, status: 'skipped' },
      select: { sequence: true },
    });
    return new Set(rows.map((r) => r.sequence));
  }

  private snapshotBatchSize(snapshotJson: string): number {
    try {
      const snap = JSON.parse(snapshotJson) as {
        delivery?: { batchSize?: number };
      };
      return Math.max(1, snap.delivery?.batchSize ?? 1);
    } catch {
      return 1;
    }
  }

  /* ----- processor-facing mutations ----- */

  async getRunRow(runId: string): Promise<RunRow> {
    const row = await this.prisma.hookRun.findUnique({ where: { id: runId } });
    if (!row) throw new NotFoundError(`Run "${runId}" not found`);
    return row;
  }

  /**
   * Whether a stop was requested for this run — works across processes (any
   * BullMQ worker can own the job, so checking the DB status is authoritative,
   * not just the local abort signal).
   */
  async cancelRequested(runId: string): Promise<boolean> {
    const r = await this.prisma.hookRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return !r || r.status === 'canceling' || r.status === 'canceled';
  }

  async markRunning(runId: string): Promise<void> {
    await this.prisma.hookRun.update({
      where: { id: runId },
      data: { status: 'running' },
    });
  }

  async setTotal(runId: string, totalCount: number | null): Promise<void> {
    await this.prisma.hookRun.update({
      where: { id: runId },
      data: { totalCount },
    });
  }

  async setCursor(runId: string, cursorOffset: number): Promise<void> {
    await this.prisma.hookRun.update({
      where: { id: runId },
      data: { cursorOffset },
    });
  }

  /**
   * Sequences the worker must not (re)send: already delivered, or skipped.
   * Used to make resume idempotent and to honor skips queued before the run.
   */
  async settledSequences(runId: string): Promise<Set<number>> {
    const rows = await this.prisma.hookDelivery.findMany({
      where: { runId, status: { in: ['success', 'skipped'] } },
      select: { sequence: true },
    });
    return new Set(rows.map((r) => r.sequence));
  }

  /** Persist one delivery and advance the run's counters atomically. */
  async recordDelivery(
    runId: string,
    meta: {
      sequence: number;
      rowIndex: number;
      rowCount: number;
      rowKeys: unknown[] | null;
    },
    outcome: DeliveryOutcome,
  ): Promise<void> {
    const rowKeysJson = meta.rowKeys ? JSON.stringify(meta.rowKeys) : null;

    // A retry re-records an existing (failed) delivery, so adjust counters by
    // the delta: remove the old status' contribution, add the new one. This is
    // what flips a red cell green and keeps the stat cards correct.
    const existing = await this.prisma.hookDelivery.findUnique({
      where: { runId_sequence: { runId, sequence: meta.sequence } },
      select: { status: true, rowCount: true },
    });
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    if (existing) {
      if (existing.status === 'success') sent -= existing.rowCount;
      else if (existing.status === 'failed') failed -= existing.rowCount;
      else if (existing.status === 'skipped') skipped -= existing.rowCount;
    }
    if (outcome.status === 'success') sent += meta.rowCount;
    else failed += meta.rowCount;

    const counters: Record<string, { increment: number }> = {};
    if (sent !== 0) counters.sentCount = { increment: sent };
    if (failed !== 0) counters.failedCount = { increment: failed };
    if (skipped !== 0) counters.skippedCount = { increment: skipped };

    await this.prisma.$transaction([
      this.prisma.hookDelivery.upsert({
        where: { runId_sequence: { runId, sequence: meta.sequence } },
        create: {
          id: randomUUID(),
          runId,
          sequence: meta.sequence,
          rowIndex: meta.rowIndex,
          rowCount: meta.rowCount,
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          attempts: outcome.attempts,
          error: outcome.error,
          rowKeysJson,
          requestBody: outcome.requestBody,
          responseBody: outcome.responseBody,
          durationMs: outcome.durationMs,
        },
        update: {
          rowKeysJson,
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          attempts: outcome.attempts,
          error: outcome.error,
          requestBody: outcome.requestBody,
          responseBody: outcome.responseBody,
          durationMs: outcome.durationMs,
        },
      }),
      this.prisma.hookRun.update({ where: { id: runId }, data: counters }),
    ]);
  }

  async finalize(
    runId: string,
    status: HookRunStatus,
    error?: string | null,
  ): Promise<void> {
    await this.prisma.hookRun.update({
      where: { id: runId },
      data: { status, error: error ?? null, finishedAt: new Date() },
    });
  }

  /* ----- boot reconcile ----- */

  async onModuleInit(): Promise<void> {
    let rows: { id: string; hookId: string }[];
    try {
      rows = await this.prisma.hookRun.findMany({
        where: { status: { in: ACTIVE } },
        select: { id: true, hookId: true },
      });
    } catch (err) {
      this.logger.warn(`Skipped run recovery: ${(err as Error).message}`);
      return;
    }
    let recovered = 0;
    for (const r of rows) {
      // Only replay runs belong to this queue. Watch/CDC runs are also `running`
      // but are owned by their own services — never re-enqueue those here.
      const hook = await this.store.get(r.hookId).catch(() => null);
      if (!hook || hook.trigger.kind !== 'replay') continue;
      // Deterministic jobId means this is a no-op if the job already exists.
      await this.enqueue(r.id, r.hookId).catch((err) =>
        this.logger.warn(
          `Could not re-enqueue run ${r.id}: ${(err as Error).message}`,
        ),
      );
      recovered++;
    }
    if (recovered) this.logger.log(`Recovered ${recovered} interrupted replay run(s)`);
  }

  /* ----- mappers ----- */

  private toRun(row: RunRow): HookRun {
    return {
      id: row.id,
      hookId: row.hookId,
      status: row.status as HookRunStatus,
      cursorOffset: row.cursorOffset,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      skippedCount: row.skippedCount,
      totalCount: row.totalCount,
      batchSize: this.snapshotBatchSize(row.configSnapshotJson),
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }

  private toDelivery(row: DeliveryRow): HookDelivery {
    return {
      id: row.id,
      runId: row.runId,
      sequence: row.sequence,
      rowIndex: row.rowIndex,
      rowCount: row.rowCount,
      status: row.status as DeliveryStatus,
      httpStatus: row.httpStatus,
      attempts: row.attempts,
      error: row.error,
      requestBody: row.requestBody,
      responseBody: row.responseBody,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
