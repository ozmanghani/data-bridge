/**
 * PostgreSQL CDC via **logical replication** — the same mechanism
 * Debezium/Fivetran use. Changes stream from the WAL in real time (no polling),
 * decoded with the built-in `pgoutput` plugin (no server extension needed). We
 * auto-provision the publication + replication slot; the one thing we can't
 * automate is `wal_level=logical` (it needs a server restart), so `readiness()`
 * checks it and tells the user exactly what to do.
 *
 * The slot persists the confirmed LSN, so a restart resumes exactly where it
 * left off. This is a verbatim extract of the original HookCdcService Postgres
 * logic, now behind the {@link CdcProvider} interface.
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@relay/core';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { AdapterPoolService } from '../../../connections/adapter-pool.service';
import type { ResolvedHook } from '../../hooks.types';
import type {
  CdcChange,
  CdcProvider,
  CdcStreamContext,
  CdcStreamHandle,
} from '../cdc-provider';

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
export class PostgresCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'postgres';
  private readonly logger = new Logger('HookCdc:pg');

  constructor(private readonly pool: AdapterPoolService) {}

  cursorAfter(a: string, b: string | null): boolean {
    return lsnAfter(a, b);
  }

  /* ----- readiness ----- */

  async readiness(dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness> {
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
      return { engine: 'postgres', supported: true, ready: logical && canReplicate, checks, instructions };
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

  async provision(hookId: string, hook: ResolvedHook): Promise<void> {
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
        await a.query(`ALTER PUBLICATION ${this.quoteIdent(pub)} SET TABLE ${target}`);
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

  async deprovision(hookId: string, hook: ResolvedHook): Promise<void> {
    if (hook.source.kind !== 'table') return;
    const slot = this.slotName(hookId);
    const pub = this.pubName(hookId);
    await this.pool.withAdapter(hook.source.connectionId, hook.source.database, async (a) => {
      await a
        .query(
          `select pg_drop_replication_slot($1) where exists (select 1 from pg_replication_slots where slot_name = $1 and active = false)`,
          [slot],
        )
        .catch(() => undefined);
      await a.query(`DROP PUBLICATION IF EXISTS ${this.quoteIdent(pub)}`).catch(() => undefined);
    });
  }

  /* ----- the stream ----- */

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const { hookId, hook, conn, handlers } = ctx;
    if (hook.source.kind !== 'table' || hook.trigger.kind !== 'cdc') {
      throw new Error('Postgres CDC requires a table source and cdc trigger.');
    }
    const src = hook.source;
    const ops = new Set<CdcOperation>(hook.trigger.operations);
    const schema = src.schema || 'public';

    const service = new LogicalReplicationService(this.clientConfig(conn, src.database), {
      acknowledge: { auto: true, timeoutSeconds: 10 },
      flowControl: { enabled: true }, // backpressure: await each delivery
    });

    service.on(
      'data',
      async (
        lsn: string,
        msg: {
          tag: string;
          relation?: { name: string; schema: string };
          new?: Record<string, unknown>;
          old?: Record<string, unknown>;
          key?: Record<string, unknown>;
        },
      ) => {
        if (msg.tag !== 'insert' && msg.tag !== 'update' && msg.tag !== 'delete') return;
        if (!ops.has(msg.tag as CdcOperation)) return;
        if (!msg.relation || msg.relation.name !== src.table || msg.relation.schema !== schema) {
          return;
        }
        const row = msg.tag === 'delete' ? (msg.old ?? msg.key ?? {}) : (msg.new ?? {});
        const change: CdcChange = { op: msg.tag as CdcOperation, row, cursor: lsn };
        await handlers.onChange(change);
      },
    );

    service.on('error', (err: Error) => handlers.onError(err));

    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [this.pubName(hookId)],
    });
    // Resumes from the slot's confirmed LSN automatically.
    service.subscribe(plugin, this.slotName(hookId)).catch((err: Error) => {
      handlers.onError(new Error(`subscribe failed: ${err.message}`));
    });

    return {
      stop: async () => {
        await service.stop().catch(() => undefined);
      },
    };
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
}
