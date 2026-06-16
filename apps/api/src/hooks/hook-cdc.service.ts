/**
 * Event-based ("CDC") hooks for PostgreSQL via **logical replication** — the
 * same mechanism Debezium/Fivetran use. Changes are streamed from the WAL in
 * real time (no polling), decoded with the built-in `pgoutput` plugin (no server
 * extension needed). We auto-provision the publication + replication slot; the
 * one thing we can't automate is `wal_level=logical` (it needs a server restart),
 * so `readiness()` checks it and tells the user exactly what to do.
 *
 * Scope: PostgreSQL only for now (other engines fall back to polling). A held
 * replication connection per active hook; the slot persists the confirmed LSN,
 * so a restart resumes exactly where it left off.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  renderRow,
  type CdcOperation,
  type CdcReadiness,
  type CdcReadinessDTO,
  type ConnectionConfig,
  type HookRun,
} from '@relay/core';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { randomUUID } from 'node:crypto';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { PrismaService } from '../common/prisma.service';
import { DeliveryService } from './delivery.service';
import { HookRunService } from './hook-run.service';
import { HookStoreService } from './hook-store.service';
import type { ResolvedHook } from './hooks.types';

interface Stream {
  service: LogicalReplicationService;
  runId: string;
  seq: number;
  /** Highest WAL position already processed — guards against replay dupes. */
  lastLsn: string | null;
}

/** Read the persisted last-delivered LSN from a run's cursorJson. */
function lsnOf(cursorJson: string | null): string | null {
  if (!cursorJson) return null;
  try {
    return (JSON.parse(cursorJson) as { lsn?: string }).lsn ?? null;
  } catch {
    return null;
  }
}

/** Compare Postgres LSNs ("H/L" hex). Returns true if `a` is strictly after `b`. */
function lsnAfter(a: string, b: string | null): boolean {
  if (!b) return true;
  try {
    const big = (l: string) => {
      const [h, lo] = l.split('/');
      if (!h || !lo) throw new Error('invalid LSN');
      return (BigInt('0x' + h) << 32n) | BigInt('0x' + lo);
    };
    return big(a) > big(b);
  } catch {
    // Conservative: treat parse failure as "not after" to avoid duplicate delivery.
    return false;
  }
}

@Injectable()
export class HookCdcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('HookCdc');
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: HookStoreService,
    private readonly connStore: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly delivery: DeliveryService,
    private readonly runs: HookRunService,
  ) {}

  /* ----- readiness (drives the builder's setup panel) ----- */

  async readiness(dto: CdcReadinessDTO): Promise<CdcReadiness> {
    const conn = await this.connStore.get(dto.connectionId);
    if (conn.engine !== 'postgres') {
      return {
        engine: conn.engine,
        supported: false,
        ready: false,
        checks: [],
        instructions: [
          `Event-based (CDC) delivery is currently available for PostgreSQL only. For ${conn.engine}, use the polling trigger instead.`,
        ],
      };
    }

    const checks: CdcReadiness['checks'] = [];
    const instructions: string[] = [];
    try {
      const res = await this.pool.withAdapter(dto.connectionId, dto.database, (a) =>
        a.query(
          `select current_setting('wal_level') as wal_level,
                  (select rolreplication or rolsuper from pg_roles where rolname = current_user) as can_replicate`,
        ),
      );
      const row = (res.rows[0] ?? {}) as { wal_level?: string; can_replicate?: boolean };
      const logical = row.wal_level === 'logical';
      const canReplicate = row.can_replicate === true;
      checks.push({
        label: 'wal_level = logical',
        ok: logical,
        detail: row.wal_level ? `currently "${row.wal_level}"` : undefined,
      });
      checks.push({ label: 'role can replicate', ok: canReplicate });
      if (!logical) {
        instructions.push(
          'Set wal_level=logical on the server (postgresql.conf or your provider’s parameter group) and restart it. This is the one step we can’t automate — it needs a server restart.',
        );
      }
      if (!canReplicate) {
        instructions.push(
          `Grant replication to the connection's role:  ALTER ROLE "${conn.user ?? 'your_user'}" REPLICATION;`,
        );
      }
      return {
        engine: 'postgres',
        supported: true,
        ready: logical && canReplicate,
        checks,
        instructions,
      };
    } catch (err) {
      return {
        engine: 'postgres',
        supported: true,
        ready: false,
        checks: [{ label: 'connect to database', ok: false, detail: (err as Error).message }],
        instructions: ['Could not query the database to check readiness.'],
      };
    }
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
    if (conn.engine !== 'postgres') {
      throw new BadRequestError('Event-based delivery is only available for PostgreSQL.');
    }
    const active = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) throw new ConflictError('This hook is already running. Stop it first.');

    const ready = await this.readiness({
      connectionId: hook.source.connectionId,
      database: hook.source.database,
      schema: hook.source.schema,
      table: hook.source.table,
    });
    if (!ready.ready) {
      throw new BadRequestError(
        `PostgreSQL isn't ready for event-based delivery. ${ready.instructions.join(' ')}`,
      );
    }

    await this.provision(hookId, hook);

    // One run per hook: resume the existing (paused) run in place rather than
    // spawning a new one. The slot remembers the LSN, so it continues cleanly.
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
    await this.beginStream(hookId, hook, conn, run.id, run.cursorOffset, lsnOf(run.cursorJson));
    this.logger.log(`Streaming changes for hook ${hookId} (run ${run.id})`);
    return this.runs.getRun(hookId, run.id);
  }

  /** Pause: stop the live stream but keep the slot so a resume continues. */
  async stop(hookId: string): Promise<HookRun | null> {
    const stream = this.streams.get(hookId);
    if (stream) {
      await stream.service.stop().catch(() => undefined);
      this.streams.delete(hookId);
    }
    const run = await this.prisma.hookRun.findFirst({
      where: { hookId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return null;
    await this.runs.finalize(run.id, 'paused');
    return this.runs.getRun(hookId, run.id);
  }

  /** Full teardown when a hook is deleted: stop stream and drop slot + publication. */
  async cleanup(hookId: string): Promise<void> {
    const stream = this.streams.get(hookId);
    if (stream) {
      await stream.service.stop().catch(() => undefined);
      this.streams.delete(hookId);
    }
    await this.deprovision(hookId).catch(() => undefined);
  }

  /** Close every replication connection on shutdown — no zombie streamers. */
  async onModuleDestroy(): Promise<void> {
    for (const stream of this.streams.values()) {
      await stream.service.stop().catch(() => undefined);
    }
    this.streams.clear();
  }

  /* ----- the stream ----- */

  private async beginStream(
    hookId: string,
    hook: ResolvedHook,
    conn: ConnectionConfig,
    runId: string,
    startSeq: number,
    startLsn: string | null,
  ): Promise<void> {
    if (hook.source.kind !== 'table' || hook.trigger.kind !== 'cdc') return;
    const src = hook.source;
    const ops = new Set<CdcOperation>(hook.trigger.operations);
    const schema = src.schema || 'public';

    const service = new LogicalReplicationService(this.clientConfig(conn, src.database), {
      acknowledge: { auto: true, timeoutSeconds: 10 },
      flowControl: { enabled: true }, // backpressure: await each delivery
    });
    const stream: Stream = { service, runId, seq: startSeq, lastLsn: startLsn };
    this.streams.set(hookId, stream);

    service.on('data', async (lsn: string, msg: { tag: string; relation?: { name: string; schema: string }; new?: Record<string, unknown>; old?: Record<string, unknown>; key?: Record<string, unknown> }) => {
      if (msg.tag !== 'insert' && msg.tag !== 'update' && msg.tag !== 'delete') return;
      if (!ops.has(msg.tag as CdcOperation)) return;
      if (!msg.relation || msg.relation.name !== src.table || msg.relation.schema !== schema) {
        return;
      }
      // Strict exactly-once: never re-process a WAL position we've already done
      // (Postgres replays from the last *acked* LSN after a reconnect).
      if (!lsnAfter(lsn, stream.lastLsn)) return;
      const row =
        msg.tag === 'delete' ? (msg.old ?? msg.key ?? {}) : (msg.new ?? {});
      await this.deliverChange(hook, stream, row, msg.tag as CdcOperation, lsn);
    });

    service.on('error', (err: Error) => {
      this.logger.warn(`CDC stream error for ${hookId}: ${err.message}`);
    });

    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [this.pubName(hookId)],
    });
    // Resumes from the slot's confirmed LSN automatically.
    service.subscribe(plugin, this.slotName(hookId)).catch((err: Error) => {
      this.logger.warn(`CDC subscribe failed for ${hookId}: ${err.message}`);
    });
  }

  private async deliverChange(
    hook: ResolvedHook,
    stream: Stream,
    row: Record<string, unknown>,
    op: CdcOperation,
    lsn: string,
  ): Promise<void> {
    if (hook.source.kind !== 'table') return;
    const seq = stream.seq;
    const now = new Date().toISOString();
    // Expose the change operation to the template as {{$op}}.
    const { body } = renderRow({ ...row, $op: op }, hook.transform, {
      table: hook.source.table,
      now,
      index: seq,
    });
    // Key on the LSN (stable per WAL change) so an at-least-once re-delivery
    // after a reconnect carries the SAME Idempotency-Key for the receiver to
    // dedupe — unlike the sequence, which changes on replay.
    const idem = hook.destination.idempotency ? `${stream.runId}:${lsn}` : undefined;
    const signal = new AbortController().signal;
    const outcome = await this.delivery.send(
      body,
      hook.destination,
      hook.delivery,
      signal,
      idem,
    );
    const pkVals = Object.values(row);
    await this.runs.recordDelivery(
      stream.runId,
      { sequence: seq, rowIndex: seq, rowCount: 1, rowKeys: pkVals.length ? pkVals : null },
      outcome,
    );
    stream.seq = seq + 1;
    stream.lastLsn = lsn; // advance the dedupe watermark (durably persisted below)
    await this.prisma.hookRun.update({
      where: { id: stream.runId },
      data: { cursorOffset: stream.seq, cursorJson: JSON.stringify({ lsn }) },
    });
  }

  /* ----- provisioning ----- */

  private pubName(hookId: string): string {
    return `relay_pub_${hookId.replace(/-/g, '')}`;
  }
  private slotName(hookId: string): string {
    return `relay_slot_${hookId.replace(/-/g, '')}`;
  }
  private quoteIdent(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }

  private async provision(hookId: string, hook: ResolvedHook): Promise<void> {
    if (hook.source.kind !== 'table') return;
    const src = hook.source;
    const schema = src.schema || 'public';
    const pub = this.pubName(hookId);
    const slot = this.slotName(hookId);
    const target = `${this.quoteIdent(schema)}.${this.quoteIdent(src.table)}`;

    await this.pool.withAdapter(src.connectionId, src.database, async (a) => {
      // Check if the publication exists and is for the correct table. If the
      // user edited the hook to change the source table, we must update the
      // publication — otherwise we'd silently stream the old table's changes.
      const pubInfo = await a.query(
        `select pub.pubname, cls.relname as tablename
         from pg_publication pub
         join pg_publication_tables pt on pt.pubname = pub.pubname
         join pg_class cls on cls.relname = pt.tablename
         where pub.pubname = $1`,
        [pub],
      );
      const existingTable = (pubInfo.rows[0] as { tablename?: string } | undefined)?.tablename;
      if (pubInfo.rows.length === 0) {
        await a.query(`CREATE PUBLICATION ${this.quoteIdent(pub)} FOR TABLE ${target}`);
      } else if (existingTable !== src.table) {
        // Table changed — update the publication in place so the slot keeps its position.
        await a.query(
          `ALTER PUBLICATION ${this.quoteIdent(pub)} SET TABLE ${target}`,
        );
        this.logger.log(`Updated CDC publication "${pub}" to target table "${src.table}"`);
      }

      const hasSlot = await a.query(
        `select 1 from pg_replication_slots where slot_name = $1`,
        [slot],
      );
      if (hasSlot.rows.length === 0) {
        await a.query(`select pg_create_logical_replication_slot($1, 'pgoutput')`, [slot]);
      }
    });
  }

  private async deprovision(hookId: string): Promise<void> {
    const run = await this.prisma.hookRun.findFirst({
      where: { hookId },
      orderBy: { startedAt: 'desc' },
      select: { configSnapshotJson: true },
    });
    if (!run) return;
    const snap = JSON.parse(run.configSnapshotJson) as { source: ResolvedHook['source'] };
    if (snap.source.kind !== 'table') return;
    const slot = this.slotName(hookId);
    const pub = this.pubName(hookId);
    await this.pool.withAdapter(snap.source.connectionId, snap.source.database, async (a) => {
      await a
        .query(
          `select pg_drop_replication_slot($1) where exists (select 1 from pg_replication_slots where slot_name = $1 and active = false)`,
          [slot],
        )
        .catch(() => undefined);
      await a.query(`DROP PUBLICATION IF EXISTS ${this.quoteIdent(pub)}`).catch(() => undefined);
    });
  }

  private clientConfig(conn: ConnectionConfig, database?: string) {
    if (conn.connectionString) {
      return { connectionString: conn.connectionString } as Record<string, unknown>;
    }
    return {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: database || conn.database,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    } as Record<string, unknown>;
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let runs: { hookId: string; id: string; cursorOffset: number; cursorJson: string | null }[];
    try {
      // All live runs; we keep only the ones whose hook is a CDC hook below.
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
        if (conn.engine !== 'postgres') continue;
        await this.beginStream(r.hookId, hook, conn, r.id, r.cursorOffset, lsnOf(r.cursorJson));
        this.logger.log(`Resumed CDC stream for hook ${r.hookId}`);
      } catch (err) {
        this.logger.warn(`Could not resume CDC ${r.hookId}: ${(err as Error).message}`);
      }
    }
  }
}
