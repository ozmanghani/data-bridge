/**
 * Event-based ("CDC") hooks — engine-agnostic orchestrator.
 *
 * Each engine captures changes differently (Postgres logical replication, MySQL
 * binlog, MongoDB change streams, Redis keyspace notifications); that variation
 * lives behind the {@link CdcProvider} interface. This service is the shared
 * machinery around them: pick the provider for a connection's engine, manage the
 * run lifecycle (one resumable run per hook), and implement the per-change
 * pipeline — dedupe replays → render → deliver → record → persist the cursor.
 *
 * A held streaming connection per active hook lives in `streams`. Durable engines
 * (pg/mysql/mongo) persist a cursor so a restart resumes exactly; Redis is
 * real-time only (see {@link RedisCdcProvider}).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  renderRow,
  type CdcOperation,
  type CdcReadiness,
  type CdcReadinessDTO,
  type ConnectionConfig,
  type DatabaseEngine,
  type HookRun,
} from '@relay/core';
import { randomUUID } from 'node:crypto';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { PrismaService } from '../common/prisma.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import { DeliveryService } from './delivery.service';
import type { ResolvedHook } from './hooks.types';
import {
  CDC_PROVIDERS,
  type CdcChange,
  type CdcProvider,
  type CdcStreamHandle,
} from './cdc/cdc-provider';

/** Live runtime state for one active CDC stream. */
interface Stream {
  handle: CdcStreamHandle;
  provider: CdcProvider;
  runId: string;
  seq: number;
  /** Highest cursor already processed — guards against replay dupes on reconnect. */
  watermark: string | null;
}

/** Read the persisted resume cursor from a run's cursorJson (legacy `lsn` ok). */
function readCursor(cursorJson: string | null): string | null {
  if (!cursorJson) return null;
  try {
    const o = JSON.parse(cursorJson) as { cursor?: string; lsn?: string };
    return o.cursor ?? o.lsn ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class HookCdcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('HookCdc');
  private readonly streams = new Map<string, Stream>();
  private readonly providers = new Map<DatabaseEngine, CdcProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: HookStoreService,
    private readonly connStore: ConnectionStoreService,
    private readonly delivery: DeliveryService,
    private readonly runs: HookRunService,
    @Inject(CDC_PROVIDERS) providers: CdcProvider[],
  ) {
    for (const p of providers) this.providers.set(p.engine, p);
  }

  private providerFor(engine: DatabaseEngine): CdcProvider | null {
    return this.providers.get(engine) ?? null;
  }

  /* ----- readiness (drives the builder's setup panel) ----- */

  async readiness(dto: CdcReadinessDTO): Promise<CdcReadiness> {
    const conn = await this.connStore.resolve(dto.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      return {
        engine: conn.engine,
        supported: false,
        ready: false,
        checks: [],
        instructions: [
          `Event-based (CDC) delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
        ],
      };
    }
    return provider.readiness(dto, conn);
  }

  /* ----- start / stop ----- */

  async start(hookId: string): Promise<HookRun> {
    const hook = await this.store.resolve(hookId);
    if (hook.trigger.kind !== 'cdc') {
      throw new BadRequestError('This hook is not configured for event-based delivery.');
    }
    if (hook.source.kind !== 'table') {
      throw new BadRequestError('Event-based hooks must read from a table.');
    }
    const conn = await this.connStore.resolve(hook.source.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      throw new BadRequestError(
        `Event-based delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
      );
    }

    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) throw new ConflictError('This hook is already running. Stop it first.');

    const ready = await provider.readiness(
      {
        connectionId: hook.source.connectionId,
        database: hook.source.database,
        schema: hook.source.schema,
        table: hook.source.table,
      },
      conn,
    );
    if (!ready.ready) {
      throw new BadRequestError(
        `${conn.engine} isn't ready for event-based delivery. ${ready.instructions.join(' ')}`,
      );
    }

    await provider.provision(hookId, hook, conn);

    // One run per hook: resume the existing (paused) run in place rather than
    // spawning a new one. Durable engines keep their cursor, so it continues cleanly.
    const latest = await this.prisma.hookRun.findFirst({
      where: { hookId },
      orderBy: { startedAt: 'desc' },
    });
    const run = latest
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
            cursorOffset: 0,
            totalCount: null,
          },
        });

    await this.beginStream(hookId, hook, conn, provider, run.id, run.cursorOffset, readCursor(run.cursorJson));
    this.logger.log(`Streaming changes for hook ${hookId} (run ${run.id}, ${conn.engine})`);
    return this.runs.getRun(hookId, run.id);
  }

  /** Pause: stop the live stream but keep durable state so a resume continues. */
  async stop(hookId: string): Promise<HookRun | null> {
    await this.teardown(hookId);
    const run = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return null;
    await this.runs.finalize(run.id, 'paused');
    return this.runs.getRun(hookId, run.id);
  }

  /** Full teardown when a hook is deleted: stop stream and drop provider state. */
  async cleanup(hookId: string): Promise<void> {
    await this.teardown(hookId);
    try {
      const hook = await this.store.resolve(hookId);
      if (hook.source.kind !== 'table') return;
      const conn = await this.connStore.resolve(hook.source.connectionId);
      const provider = this.providerFor(conn.engine);
      await provider?.deprovision(hookId, hook, conn).catch(() => undefined);
    } catch {
      /* hook/connection already gone — nothing to deprovision */
    }
  }

  /** Close every streaming connection on shutdown — no zombie streamers. */
  async onModuleDestroy(): Promise<void> {
    for (const hookId of [...this.streams.keys()]) {
      await this.teardown(hookId);
    }
  }

  private async teardown(hookId: string): Promise<void> {
    const stream = this.streams.get(hookId);
    if (!stream) return;
    this.streams.delete(hookId);
    await stream.handle.stop().catch(() => undefined);
  }

  /* ----- the shared change pipeline ----- */

  private async beginStream(
    hookId: string,
    hook: ResolvedHook,
    conn: ConnectionConfig,
    provider: CdcProvider,
    runId: string,
    startSeq: number,
    startCursor: string | null,
  ): Promise<void> {
    const stream: Stream = { handle: { stop: async () => undefined }, provider, runId, seq: startSeq, watermark: startCursor };
    this.streams.set(hookId, stream);

    const handle = await provider.startStream({
      hookId,
      hook,
      conn,
      fromCursor: startCursor,
      handlers: {
        onChange: (change) => this.handleChange(hookId, hook, change),
        onError: (err) => this.logger.warn(`CDC stream error for ${hookId}: ${err.message}`),
      },
    });
    // The provider may have already begun emitting; only replace the placeholder.
    stream.handle = handle;
  }

  /** Dedupe → render → deliver → record → persist cursor, for one change. */
  private async handleChange(
    hookId: string,
    hook: ResolvedHook,
    change: CdcChange,
  ): Promise<void> {
    const stream = this.streams.get(hookId);
    if (!stream || hook.source.kind !== 'table') return;
    // Strict exactly-once: never re-process a position we've already done
    // (durable engines replay from the last acked cursor after a reconnect).
    if (!stream.provider.cursorAfter(change.cursor, stream.watermark)) return;

    const seq = stream.seq;
    const now = new Date().toISOString();
    // Expose the change operation to the template as {{$op}}.
    const { body } = renderRow({ ...change.row, $op: change.op as CdcOperation }, hook.transform, {
      table: hook.source.table,
      now,
      index: seq,
    });
    // Key on the cursor (stable per change) so an at-least-once re-delivery after
    // a reconnect carries the SAME Idempotency-Key for the receiver to dedupe.
    const idem = hook.destination.idempotency ? `${stream.runId}:${change.cursor}` : undefined;
    const signal = new AbortController().signal;
    const outcome = await this.delivery.send(body, hook.destination, hook.delivery, signal, idem);

    const pkVals = Object.values(change.row);
    await this.runs.recordDelivery(
      stream.runId,
      { sequence: seq, rowIndex: seq, rowCount: 1, rowKeys: pkVals.length ? pkVals : null },
      outcome,
    );
    stream.seq = seq + 1;
    stream.watermark = change.cursor;
    await this.prisma.hookRun.update({
      where: { id: stream.runId },
      data: { cursorOffset: stream.seq, cursorJson: JSON.stringify({ cursor: change.cursor }) },
    });
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let runs: { hookId: string; id: string; cursorOffset: number; cursorJson: string | null }[];
    try {
      runs = await this.prisma.hookRun.findMany({
        where: { status: 'running' },
        select: { hookId: true, id: true, cursorOffset: true, cursorJson: true },
      });
    } catch {
      return;
    }
    for (const r of runs) {
      try {
        const hook = await this.store.resolve(r.hookId);
        if (hook.trigger.kind !== 'cdc' || !hook.enabled || hook.source.kind !== 'table') continue;
        const conn = await this.connStore.resolve(hook.source.connectionId);
        const provider = this.providerFor(conn.engine);
        if (!provider) continue;
        await provider.provision(r.hookId, hook, conn).catch(() => undefined);
        await this.beginStream(r.hookId, hook, conn, provider, r.id, r.cursorOffset, readCursor(r.cursorJson));
        this.logger.log(`Resumed CDC stream for hook ${r.hookId} (${conn.engine})`);
      } catch (err) {
        this.logger.warn(`Could not resume CDC ${r.hookId}: ${(err as Error).message}`);
      }
    }
  }
}
