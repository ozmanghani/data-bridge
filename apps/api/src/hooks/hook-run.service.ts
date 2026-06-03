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
  ConflictError,
  type HookDelivery,
  type HookRun,
  type HookRunStatus,
  NotFoundError,
} from '@relay/core';
import { Queue } from 'bullmq';
import type { HookDelivery as DeliveryRow, HookRun as RunRow } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { HookStoreService } from './hook-store.service';
import { RunRegistryService } from './run-registry.service';
import { HOOK_RUNS_QUEUE, type DeliveryOutcome, type HookRunJob } from './hooks.types';

const ACTIVE: HookRunStatus[] = ['queued', 'running', 'canceling'];
const TERMINAL: HookRunStatus[] = ['completed', 'failed', 'canceled', 'interrupted'];

@Injectable()
export class HookRunService implements OnModuleInit {
  private readonly logger = new Logger('HookRun');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: HookStoreService,
    private readonly registry: RunRegistryService,
    @InjectQueue(HOOK_RUNS_QUEUE) private readonly queue: Queue<HookRunJob>,
  ) {}

  /* ----- start / resume ----- */

  async start(hookId: string, resumeRunId?: string): Promise<HookRun> {
    await this.store.get(hookId); // 404 if the hook is gone

    if (resumeRunId) return this.resume(hookId, resumeRunId);

    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ACTIVE } },
    });
    if (active) {
      throw new ConflictError(
        'A run is already in progress for this hook. Cancel it before starting another.',
      );
    }

    await this.ensureQueueReady();
    const id = randomUUID();
    const snapshot = await this.store.snapshotJson(hookId);
    const row = await this.prisma.hookRun.create({
      data: { id, hookId, status: 'queued', configSnapshotJson: snapshot },
    });
    await this.enqueue(id, hookId);
    return this.toRun(row);
  }

  private async resume(hookId: string, runId: string): Promise<HookRun> {
    const row = await this.getRunRow(runId);
    if (row.hookId !== hookId) throw new NotFoundError(`Run "${runId}" not found`);
    if (!TERMINAL.includes(row.status as HookRunStatus) || row.status === 'completed') {
      throw new ConflictError(`Run "${runId}" cannot be resumed (status: ${row.status}).`);
    }
    await this.ensureQueueReady();
    const reset = await this.prisma.hookRun.update({
      where: { id: runId },
      data: { status: 'queued', error: null, finishedAt: null },
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
    if (row.hookId !== hookId) throw new NotFoundError(`Run "${runId}" not found`);
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
    if (row.hookId !== hookId) throw new NotFoundError(`Run "${runId}" not found`);
    return this.toRun(row);
  }

  async listDeliveries(
    runId: string,
    opts: { status?: 'success' | 'failed'; offset?: number; limit?: number } = {},
  ): Promise<HookDelivery[]> {
    const rows = await this.prisma.hookDelivery.findMany({
      where: { runId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { sequence: 'asc' },
      skip: opts.offset ?? 0,
      take: Math.min(opts.limit ?? 100, 500),
    });
    return rows.map((r) => this.toDelivery(r));
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
    await this.prisma.hookRun.update({ where: { id: runId }, data: { totalCount } });
  }

  async setCursor(runId: string, cursorOffset: number): Promise<void> {
    await this.prisma.hookRun.update({ where: { id: runId }, data: { cursorOffset } });
  }

  /** Sequences already delivered successfully — skipped on resume. */
  async succeededSequences(runId: string): Promise<Set<number>> {
    const rows = await this.prisma.hookDelivery.findMany({
      where: { runId, status: 'success' },
      select: { sequence: true },
    });
    return new Set(rows.map((r) => r.sequence));
  }

  /** Persist one delivery and advance the run's counters atomically. */
  async recordDelivery(
    runId: string,
    meta: { sequence: number; rowIndex: number; rowCount: number },
    outcome: DeliveryOutcome,
  ): Promise<void> {
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
          responseSnippet: outcome.responseSnippet,
          durationMs: outcome.durationMs,
        },
        update: {
          status: outcome.status,
          httpStatus: outcome.httpStatus,
          attempts: outcome.attempts,
          error: outcome.error,
          responseSnippet: outcome.responseSnippet,
          durationMs: outcome.durationMs,
        },
      }),
      this.prisma.hookRun.update({
        where: { id: runId },
        data:
          outcome.status === 'success'
            ? { sentCount: { increment: meta.rowCount } }
            : { failedCount: { increment: meta.rowCount } },
      }),
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
    for (const r of rows) {
      // Deterministic jobId means this is a no-op if the job already exists.
      await this.enqueue(r.id, r.hookId).catch((err) =>
        this.logger.warn(`Could not re-enqueue run ${r.id}: ${(err as Error).message}`),
      );
    }
    if (rows.length) this.logger.log(`Recovered ${rows.length} interrupted hook run(s)`);
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
      totalCount: row.totalCount,
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
      status: row.status as 'success' | 'failed',
      httpStatus: row.httpStatus,
      attempts: row.attempts,
      error: row.error,
      responseSnippet: row.responseSnippet,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
