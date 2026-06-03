/**
 * BullMQ worker that executes a hook run. One job == one run (`jobId = runId`),
 * so the run's lifecycle is the job's lifecycle — no cross-job bookkeeping.
 *
 * Streaming: rows are read a page at a time (table) or once (query) and grouped
 * into batches of `batchSize`. Each batch is one HTTP delivery. Only a single
 * page is ever held in memory, and deliveries are awaited sequentially, which
 * gives natural backpressure and lets `minDelayMs` pace the send rate.
 *
 * Resumability: the run checkpoints `cursorOffset` at every batch boundary
 * (always batch-aligned), so a stalled-job recovery or explicit resume restarts
 * mid-stream. The `(runId, sequence)` unique row + a skip-set of already-succeeded
 * sequences make re-delivery idempotent. `sequence = floor(rowIndex / batchSize)`
 * is deterministic, so the numbering lines up across attempts.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { BadRequestError, renderBatch, renderRow, type SortSpec } from '@relay/core';
import type { Job } from 'bullmq';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { runtimeConfig } from '../common/runtime-config';
import { sleep } from './delivery.service';
import { DeliveryService } from './delivery.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { RunRegistryService } from './run-registry.service';
import { HOOK_RUNS_QUEUE, type HookRunJob, type ResolvedHook } from './hooks.types';

interface StreamItem {
  row: Record<string, unknown>;
  index: number;
}

@Processor(HOOK_RUNS_QUEUE, { concurrency: runtimeConfig.hookConcurrency })
export class HookRunProcessor extends WorkerHost {
  private readonly logger = new Logger('HookRunProcessor');

  constructor(
    private readonly runs: HookRunService,
    private readonly store: HookStoreService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
    private readonly registry: RunRegistryService,
  ) {
    super();
  }

  async process(job: Job<HookRunJob>): Promise<void> {
    const { runId } = job.data;
    const row = await this.runs.getRunRow(runId);

    // Already settled by a previous attempt, or canceled before we started.
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(row.status)) return;
    if (row.status === 'canceling') {
      await this.runs.finalize(runId, 'canceled');
      return;
    }

    const controller = this.registry.register(runId);
    try {
      await this.execute(runId, row.cursorOffset, row.configSnapshotJson, controller.signal);
    } finally {
      this.registry.release(runId);
    }
  }

  private async execute(
    runId: string,
    startOffset: number,
    snapshotJson: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.runs.markRunning(runId);
    const hook = this.store.resolveSnapshot(snapshotJson);
    const { delivery } = hook;
    const batchSize = delivery.batchSize;
    const table = hook.source.kind === 'table' ? hook.source.table : '(query)';
    const done = await this.runs.succeededSequences(runId);

    // Cancellation works across processes: any worker may own the job, so the
    // local abort signal alone isn't authoritative. Poll the run status too,
    // throttled to keep DB load negligible on high-throughput runs.
    let lastStatusCheck = 0;
    const stopRequested = async (): Promise<boolean> => {
      if (signal.aborted) return true;
      const now = Date.now();
      if (now - lastStatusCheck < 750) return false;
      lastStatusCheck = now;
      return this.runs.cancelRequested(runId);
    };

    let buffer: Record<string, unknown>[] = [];
    let bufferStart = startOffset;

    try {
      for await (const item of this.streamRows(hook, runId, startOffset)) {
        if (await stopRequested()) {
          await this.runs.finalize(runId, 'canceled');
          return;
        }
        buffer.push(item.row);
        if (buffer.length === batchSize) {
          const stop = await this.flush(runId, table, buffer, bufferStart, done, hook, signal);
          buffer = [];
          bufferStart = item.index + 1;
          await this.runs.setCursor(runId, bufferStart);
          if (stop) {
            await this.runs.finalize(runId, 'failed', 'Stopped after a failed delivery (onError=abort).');
            return;
          }
          await sleep(delivery.minDelayMs, signal);
        }
      }

      if (buffer.length > 0) {
        if (await stopRequested()) {
          await this.runs.finalize(runId, 'canceled');
          return;
        }
        const stop = await this.flush(runId, table, buffer, bufferStart, done, hook, signal);
        if (stop) {
          await this.runs.finalize(runId, 'failed', 'Stopped after a failed delivery (onError=abort).');
          return;
        }
      }

      await this.runs.finalize(runId, (await stopRequested()) ? 'canceled' : 'completed');
    } catch (err) {
      if (signal.aborted || (await this.runs.cancelRequested(runId))) {
        await this.runs.finalize(runId, 'canceled');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Run ${runId} failed: ${message}`);
      await this.runs.finalize(runId, 'failed', message);
    }
  }

  /** Render + deliver one batch; returns true if the run should abort. */
  private async flush(
    runId: string,
    table: string,
    rows: Record<string, unknown>[],
    startIndex: number,
    done: Set<number>,
    hook: ResolvedHook,
    signal: AbortSignal,
  ): Promise<boolean> {
    const batchSize = hook.delivery.batchSize;
    const sequence = Math.floor(startIndex / batchSize);
    if (done.has(sequence)) return false; // already delivered on a prior attempt

    const now = new Date().toISOString();
    const { body } =
      rows.length === 1
        ? renderRow(rows[0]!, hook.transform, { table, now, index: startIndex })
        : renderBatch(rows, hook.transform, startIndex, { table, now });

    const outcome = await this.delivery.send(
      body,
      hook.destination,
      hook.delivery,
      signal,
      `${runId}:${sequence}`,
    );
    await this.runs.recordDelivery(
      runId,
      { sequence, rowIndex: startIndex, rowCount: rows.length },
      outcome,
    );
    return outcome.status === 'failed' && hook.delivery.onError === 'abort';
  }

  /* ----- row streaming ----- */

  private streamRows(
    hook: ResolvedHook,
    runId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    return hook.source.kind === 'table'
      ? this.streamTable(hook, runId, startOffset)
      : this.streamQuery(hook, runId, startOffset);
  }

  private async *streamTable(
    hook: ResolvedHook,
    runId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    if (hook.source.kind !== 'table') return;
    const src = hook.source;
    const { sort, total } = await this.resolveTableOrder(hook);
    await this.runs.setTotal(runId, total);

    let offset = startOffset;
    for (;;) {
      const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a.browse({
          schema: src.schema,
          table: src.table,
          filters: src.filters,
          sort,
          limit: hook.delivery.pageSize,
          offset,
        }),
      );
      for (let i = 0; i < page.rows.length; i++) {
        yield { row: page.rows[i]!, index: offset + i };
      }
      if (!page.hasMore || page.rows.length === 0) return;
      offset += page.rows.length;
    }
  }

  /**
   * A stable order is mandatory: `LIMIT/OFFSET` without `ORDER BY` can skip or
   * repeat rows across pages. Use the caller's sort, else the primary key.
   */
  private async resolveTableOrder(
    hook: ResolvedHook,
  ): Promise<{ sort: SortSpec[]; total: number | null }> {
    if (hook.source.kind !== 'table') return { sort: [], total: null };
    const src = hook.source;
    const probe = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.browse({ schema: src.schema, table: src.table, filters: src.filters, limit: 1, offset: 0 }),
    );
    if (src.sort && src.sort.length > 0) return { sort: src.sort, total: probe.total };
    if (probe.primaryKey.length > 0) {
      return {
        sort: probe.primaryKey.map((column) => ({ column, direction: 'asc' as const })),
        total: probe.total,
      };
    }
    throw new BadRequestError(
      `Table "${src.table}" has no primary key, so rows cannot be paged in a stable order. Add a sort to the hook to replay it safely.`,
    );
  }

  private async *streamQuery(
    hook: ResolvedHook,
    runId: string,
    startOffset: number,
  ): AsyncGenerator<StreamItem> {
    if (hook.source.kind !== 'query') return;
    const src = hook.source;
    const result = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
      a.query(src.statement),
    );
    if (result.truncated) {
      throw new BadRequestError(
        `Query result was capped at ${result.rowCount} rows (limit ${runtimeConfig.maxQueryRows}). ` +
          `Narrow the query, or use a table source to replay every row.`,
      );
    }
    await this.runs.setTotal(runId, result.rows.length);
    for (let i = startOffset; i < result.rows.length; i++) {
      yield { row: result.rows[i]!, index: i };
    }
  }
}
