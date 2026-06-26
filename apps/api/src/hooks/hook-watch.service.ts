/**
 * "watch" hooks: live listeners that poll a table for new rows and deliver them
 * as they show up. each watch hook drives a single long-lived "watch run"
 * (status `running`) plus a BullMQ job scheduler that fires a poll every
 * `pollIntervalMs`. schedulers persist in Redis, so listening survives restarts;
 * `onModuleInit` re-registers any that should still be active.
 *
 * the change-detection itself is the pure engine in `@data-bridge/core`
 * (`watchQuery` / `advanceCursor`); this service is the I/O around it: fetch a
 * page, deliver the new rows, persist the advanced cursor.
 */
import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  advanceCursor,
  emptyCursor,
  rowKey,
  watchQuery,
  watchStrategySchema,
  type HookRun,
  type WatchCursor,
} from '@data-bridge/core';
import { Queue } from 'bullmq';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { PrismaService } from '../common/prisma.service';
import { sleep } from './delivery.service';
import { HookSinkService } from './hook-sink.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import type { ResolvedHook } from './hooks.types';
import { HOOK_WATCH_QUEUE, type HookWatchJob } from './hooks.types';

@Injectable()
export class HookWatchService implements OnModuleInit {
  private readonly logger = new Logger('HookWatch');
  /** in-process guard: never poll the same hook concurrently (single worker) */
  private readonly polling = new Set<string>();
  /** adaptive cadence: empty-poll streak + currently-scheduled interval per hook */
  private readonly emptyStreak = new Map<string, number>();
  private readonly scheduledEvery = new Map<string, number>();

  /** fastest cadence (ms) when rows are actively flowing */
  private static readonly FAST_MS = 1000;
  /** stay fast for this many empty polls after activity before backing off */
  private static readonly COOLDOWN_POLLS = 4;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: HookStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: HookSinkService,
    private readonly runs: HookRunService,
    @InjectQueue(HOOK_WATCH_QUEUE) private readonly queue: Queue<HookWatchJob>,
  ) {}

  /* ----- start / stop ----- */

  async start(hookId: string): Promise<HookRun> {
    const hook = await this.store.resolve(hookId);
    if (hook.trigger.kind !== 'watch') {
      throw new BadRequestError('This hook is not configured to listen.');
    }
    if (hook.source.kind !== 'table') {
      throw new BadRequestError('Watch hooks must read from a table.');
    }
    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) {
      throw new ConflictError('This hook is already running. Stop it first.');
    }

    await this.ensureQueueReady();
    // one run per hook: resume the existing (paused) run in place, keeping its
    // cursor, rather than spawning a new one each time
    const latest = await this.prisma.hookRun.findFirst({
      where: { hookId },
      orderBy: { startedAt: 'desc' },
    });
    const run =
      latest && latest.cursorJson
        ? await this.prisma.hookRun.update({
            where: { id: latest.id },
            data: { status: 'running', error: null, finishedAt: null },
          })
        : await this.prisma.hookRun.create({
            data: {
              id: randomUUID(),
              hookId,
              status: 'running',
              configSnapshotJson: await this.store.snapshotJson(hookId),
              cursorJson: JSON.stringify(await this.initialCursor(hook)),
              cursorOffset: 0,
              totalCount: null,
            },
          });
    // start responsive, adapt() eases off when the table goes quiet
    const fast = Math.min(HookWatchService.FAST_MS, hook.trigger.pollIntervalMs);
    this.emptyStreak.set(hookId, 0);
    this.scheduledEvery.set(hookId, fast);
    await this.schedule(hookId, fast);
    this.logger.log(`Listening on hook ${hookId} (run ${run.id})`);
    return this.runs.getRun(hookId, run.id);
  }

  async stop(hookId: string): Promise<HookRun | null> {
    await this.unschedule(hookId);
    const run = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return null;
    await this.runs.finalize(run.id, 'paused');
    return this.runs.getRun(hookId, run.id);
  }

  /* ----- the poll cycle (invoked by the processor) ----- */

  async poll(hookId: string): Promise<void> {
    if (this.polling.has(hookId)) return; // skip an overlapping fire
    this.polling.add(hookId);
    try {
      await this.runPoll(hookId);
    } catch (err) {
      this.logger.warn(`Watch poll for ${hookId} failed: ${(err as Error).message}`);
    } finally {
      this.polling.delete(hookId);
    }
  }

  private async runPoll(hookId: string): Promise<void> {
    const run = await this.prisma.hookRun.findFirst({
      where: { hookId, status: 'running', cursorJson: { not: null } },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) {
      // nothing is listening (stopped/never started), retire the scheduler
      await this.unschedule(hookId);
      return;
    }

    const hook = await this.store.resolve(hookId);
    if (!hook.enabled || hook.trigger.kind !== 'watch' || hook.source.kind !== 'table') {
      await this.runs.finalize(run.id, 'canceled');
      await this.unschedule(hookId);
      return;
    }

    const strategy = watchStrategySchema.parse(hook.trigger.strategy);
    let cursor: WatchCursor;
    try {
      cursor = JSON.parse(run.cursorJson!) as WatchCursor;
    } catch {
      const msg = `Watch run ${run.id} has an unparseable cursor — marking it failed so the user can restart cleanly.`;
      this.logger.error(msg);
      await this.runs.finalize(run.id, 'failed', msg);
      await this.unschedule(hookId);
      return;
    }
    const { filters, sort } = watchQuery(strategy, cursor);
    const src = hook.source;
    const limit =
      strategy.strategy === 'snapshot'
        ? Math.min(strategy.maxTracked, 1000)
        : hook.trigger.maxPerPoll;

    const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.browse({
        schema: src.schema,
        table: src.table,
        filters: filters.length ? filters : undefined,
        sort: sort.length ? sort : undefined,
        limit: Math.min(limit, 1000),
        offset: 0,
      }),
    );
    const pk = page.primaryKey;
    const { newRows, cursor: next } = advanceCursor(strategy, cursor, page.rows, pk);

    const signal = new AbortController().signal;
    let seq = run.cursorOffset;
    for (const row of newRows) {
      const now = new Date().toISOString();
      const idem =
        hook.destination.kind === 'http' && hook.destination.idempotency
          ? `${run.id}:${seq}`
          : undefined;
      const { outcome } = await this.sink.deliver(
        hook,
        [row],
        { table: src.table, now, startIndex: seq },
        signal,
        idem,
      );
      await this.runs.recordDelivery(
        run.id,
        {
          sequence: seq,
          rowIndex: seq,
          rowCount: 1,
          rowKeys: pk.length ? pk.map((c) => row[c]) : null,
        },
        outcome,
      );
      seq++;
      if (hook.delivery.minDelayMs) await sleep(hook.delivery.minDelayMs);
    }

    await this.prisma.hookRun.update({
      where: { id: run.id },
      data: { cursorJson: JSON.stringify(next), cursorOffset: seq },
    });

    await this.adapt(hookId, hook.trigger.pollIntervalMs, newRows.length > 0);
  }

  /**
   * adaptive cadence: poll fast while rows are flowing, then ease back to the
   * configured (idle) interval after a short cooldown. keeps a busy table
   * near-real-time while a quiet one barely touches the database, all without
   * any DB-side changes.
   */
  private async adapt(hookId: string, idleMs: number, hadRows: boolean): Promise<void> {
    const fast = Math.min(HookWatchService.FAST_MS, idleMs);
    const streak = hadRows ? 0 : (this.emptyStreak.get(hookId) ?? 0) + 1;
    this.emptyStreak.set(hookId, streak);
    const desired = streak < HookWatchService.COOLDOWN_POLLS ? fast : idleMs;
    if (this.scheduledEvery.get(hookId) !== desired) {
      this.scheduledEvery.set(hookId, desired);
      await this.schedule(hookId, desired);
    }
  }

  /* ----- initial cursor, so `startFrom: now` ignores existing rows ----- */

  private async initialCursor(hook: ResolvedHook): Promise<WatchCursor> {
    if (hook.trigger.kind !== 'watch' || hook.source.kind !== 'table') {
      throw new BadRequestError('Watch hooks must read from a table.');
    }
    const strategy = watchStrategySchema.parse(hook.trigger.strategy);
    if (hook.trigger.startFrom === 'beginning') return emptyCursor(strategy);

    const src = hook.source;
    const cid = src.connectionId;
    const db = src.database;

    if (strategy.strategy === 'increment') {
      const page = await this.pool.withAdapter(cid, db, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          sort: [{ column: strategy.column, direction: 'desc' }],
          limit: 1,
          offset: 0,
        }),
      );
      return { strategy: 'increment', value: page.rows[0]?.[strategy.column] ?? null };
    }

    if (strategy.strategy === 'timestamp') {
      const top = await this.pool.withAdapter(cid, db, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          sort: [{ column: strategy.column, direction: 'desc' }],
          limit: 1,
          offset: 0,
        }),
      );
      const maxTs = top.rows[0]?.[strategy.column];
      if (maxTs == null) return emptyCursor(strategy);
      // remember every row already at the max timestamp so they aren't re-sent
      const at = await this.pool.withAdapter(cid, db, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          filters: [{ column: strategy.column, operator: 'gte', value: maxTs }],
          sort: [{ column: strategy.column, direction: 'asc' }],
          limit: 1000,
          offset: 0,
        }),
      );
      return {
        strategy: 'timestamp',
        ts: maxTs instanceof Date ? maxTs.toISOString() : maxTs,
        boundaryKeys: at.rows.map((r) => rowKey(r, at.primaryKey)),
      };
    }

    // snapshot: seed the seen-set with current primary keys (bounded)
    const page = await this.pool.withAdapter(cid, db, (a) =>
      a.browse({
        schema: src.schema,
        table: src.table,
        limit: Math.min(strategy.maxTracked, 1000),
        offset: 0,
      }),
    );
    return { strategy: 'snapshot', seen: page.rows.map((r) => rowKey(r, page.primaryKey)) };
  }

  /* ----- scheduler plumbing ----- */

  private schedulerId(hookId: string): string {
    return `watch:${hookId}`;
  }

  private async schedule(hookId: string, every: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      this.schedulerId(hookId),
      { every },
      { name: 'poll', data: { hookId } },
    );
  }

  private async unschedule(hookId: string): Promise<void> {
    this.emptyStreak.delete(hookId);
    this.scheduledEvery.delete(hookId);
    await this.queue.removeJobScheduler(this.schedulerId(hookId)).catch(() => false);
  }

  private async ensureQueueReady(): Promise<void> {
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000),
        ),
      ]);
    } catch {
      throw new AppError(
        'CONNECTION_FAILED',
        'The job queue (Redis) is unavailable. Start it with `docker compose up -d redis` or set REDIS_URL.',
        503,
      );
    }
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let rows: { hookId: string }[];
    try {
      rows = await this.prisma.hookRun.findMany({
        where: { status: 'running', cursorJson: { not: null } },
        select: { hookId: true },
      });
    } catch (err) {
      this.logger.warn(`Skipped watch recovery: ${(err as Error).message}`);
      return;
    }
    for (const { hookId } of rows) {
      try {
        const hook = await this.store.get(hookId);
        if (hook.trigger.kind === 'watch' && hook.enabled) {
          await this.schedule(hookId, hook.trigger.pollIntervalMs);
        }
      } catch (err) {
        this.logger.warn(`Could not resume watch ${hookId}: ${(err as Error).message}`);
      }
    }
    if (rows.length) this.logger.log(`Resumed ${rows.length} watch listener(s)`);
  }
}
