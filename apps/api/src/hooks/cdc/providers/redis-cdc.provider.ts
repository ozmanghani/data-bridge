/**
 * Redis CDC via **keyspace notifications** (pub/sub on `__keyevent@<db>__:*`).
 *
 * IMPORTANT — this is real-time but NON-DURABLE by nature:
 *  - Keyspace notifications are fire-and-forget pub/sub with no backlog. Any
 *    event published while Relay is disconnected (restart, network blip) is
 *    permanently lost — there is no resume cursor.
 *  - The event carries only the KEY, not the value; we do a best-effort
 *    follow-up read to populate the row (the key may already be gone for deletes).
 *  - Redis can't distinguish create vs overwrite, so all writes map to `update`.
 *
 * These limitations are surfaced in the readiness instructions so the user knows
 * exactly what they're getting. For durable Redis change capture, polling
 * (watch) is actually the more reliable choice.
 */
import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@relay/core';
import type { ResolvedHook } from '../../hooks.types';
import type {
  CdcChange,
  CdcProvider,
  CdcStreamContext,
  CdcStreamHandle,
} from '../cdc-provider';

/** Events that mean the key is gone. Everything else is treated as a write. */
const DELETE_EVENTS = new Set(['del', 'unlink', 'expired', 'evicted', 'expire']);

@Injectable()
export class RedisCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'redis';
  private readonly logger = new Logger('HookCdc:redis');

  // No durable position — every delivered event is "new".
  cursorAfter(): boolean {
    return true;
  }

  private dbIndex(conn: ConnectionConfig): number {
    const idx = Number(conn.options?.db ?? conn.database ?? 0);
    return Number.isFinite(idx) ? idx : 0;
  }

  private newClient(conn: ConnectionConfig): Redis {
    if (conn.connectionString) {
      return new Redis(conn.connectionString, { lazyConnect: true, maxRetriesPerRequest: null });
    }
    return new Redis({
      host: conn.host ?? 'localhost',
      port: conn.port ?? 6379,
      username: conn.user || undefined,
      password: conn.password || undefined,
      db: this.dbIndex(conn),
      tls: conn.ssl ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      connectTimeout: 8000,
    });
  }

  /* ----- readiness ----- */

  async readiness(_dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness> {
    const checks: CdcReadiness['checks'] = [];
    const instructions: string[] = [];
    const client = this.newClient(conn);
    try {
      await client.connect();
      const res = (await client.config('GET', 'notify-keyspace-events')) as string[];
      const flags = res?.[1] ?? '';
      // We subscribe to keyevent channels, so we need 'E' plus event classes
      // ('A' = all classes, or the specific generic/string/etc. flags).
      const hasEvent = flags.includes('E');
      const hasClasses = flags.includes('A') || /[g$lshzxet]/.test(flags);
      const ok = hasEvent && hasClasses;
      checks.push({
        label: 'notify-keyspace-events enabled',
        ok,
        detail: flags ? `currently "${flags}"` : 'currently empty (disabled)',
      });
      if (!ok) {
        instructions.push(
          'Enable keyspace notifications:  CONFIG SET notify-keyspace-events EA  (or set `notify-keyspace-events EA` in redis.conf). Relay will attempt this automatically on start; managed Redis may require enabling it in the provider console.',
        );
      }
      instructions.push(
        'Note: Redis change capture is real-time only. Events that occur while Relay is offline cannot be recovered, and the changed value is fetched after the fact (best-effort).',
      );
      return { engine: 'redis', supported: true, ready: ok, checks, instructions };
    } catch (err) {
      return {
        engine: 'redis',
        supported: true,
        ready: false,
        checks: [{ label: 'connect to Redis', ok: false, detail: (err as Error).message }],
        instructions: ['Could not connect to Redis to check readiness.'],
      };
    } finally {
      client.disconnect();
    }
  }

  /* ----- provisioning: best-effort enable of keyspace notifications ----- */

  async provision(_hookId: string, _hook: ResolvedHook, conn: ConnectionConfig): Promise<void> {
    const client = this.newClient(conn);
    try {
      await client.connect();
      const res = (await client.config('GET', 'notify-keyspace-events')) as string[];
      const flags = res?.[1] ?? '';
      if (!(flags.includes('E') && (flags.includes('A') || /[g$lshzxet]/.test(flags)))) {
        // Try to turn it on ourselves; harmless if it's already adequate.
        await client.config('SET', 'notify-keyspace-events', 'EA').catch((err: Error) => {
          this.logger.warn(`Could not auto-enable keyspace notifications: ${err.message}`);
        });
      }
    } catch (err) {
      this.logger.warn(`Redis provision skipped: ${(err as Error).message}`);
    } finally {
      client.disconnect();
    }
  }

  async deprovision(): Promise<void> {
    /* no-op: we don't disable notifications (other consumers may rely on them) */
  }

  /* ----- the stream ----- */

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const { hook, conn, handlers } = ctx;
    if (hook.source.kind !== 'table' || hook.trigger.kind !== 'cdc') {
      throw new Error('Redis CDC requires a source and cdc trigger.');
    }
    const ops = new Set<CdcOperation>(hook.trigger.operations);
    const wantsWrite = ops.has('update') || ops.has('insert');
    const wantsDelete = ops.has('delete');
    const db = this.dbIndex(conn);
    // Optional key glob filter (e.g. "user:*"); falls back to all keys.
    const keyGlob = this.keyPattern(hook);

    const sub = this.newClient(conn); // subscriber connection (no normal commands)
    const reader = this.newClient(conn); // best-effort value reader
    await sub.connect();
    await reader.connect();

    let seq = 0;
    sub.on('error', (err: Error) => handlers.onError(err));

    sub.on('pmessage', (_pattern: string, channel: string, key: string) => {
      // channel: __keyevent@<db>__:<event>   message: <key>
      const event = channel.slice(channel.indexOf(':') + 1);
      if (keyGlob && !this.globMatch(keyGlob, key)) return;
      const isDelete = DELETE_EVENTS.has(event);
      if (isDelete ? !wantsDelete : !wantsWrite) return;

      const op: CdcOperation = isDelete ? 'delete' : 'update';
      const cursor = `${Date.now()}:${seq++}`; // synthetic, non-durable

      // Resolve value out-of-band; never block the subscriber socket on it.
      void this.buildRow(reader, key, event, isDelete)
        .then((row) => handlers.onChange({ op, row, cursor }))
        .catch((err) => handlers.onError(err as Error));
    });

    await sub.psubscribe(`__keyevent@${db}__:*`);

    return {
      stop: async () => {
        sub.disconnect();
        reader.disconnect();
      },
    };
  }

  /** Best-effort read of the current value for a changed key. */
  private async buildRow(
    reader: Redis,
    key: string,
    event: string,
    isDelete: boolean,
  ): Promise<Record<string, unknown>> {
    const base = { key, event };
    if (isDelete) return base; // value is gone
    try {
      const type = await reader.type(key);
      switch (type) {
        case 'string':
          return { ...base, type, value: await reader.get(key) };
        case 'hash':
          return { ...base, type, value: await reader.hgetall(key) };
        case 'list':
          return { ...base, type, value: await reader.lrange(key, 0, -1) };
        case 'set':
          return { ...base, type, value: await reader.smembers(key) };
        case 'zset':
          return { ...base, type, value: await reader.zrange(key, 0, -1, 'WITHSCORES') };
        default:
          return { ...base, type }; // 'none' (already gone) or unsupported
      }
    } catch {
      return base; // key vanished between event and read
    }
  }

  /** Pull an optional key glob from the hook source filters, if present. */
  private keyPattern(hook: ResolvedHook): string | null {
    if (hook.source.kind !== 'table') return null;
    const filters = (hook.source as { filters?: { column: string; value: unknown }[] }).filters;
    const keyFilter = filters?.find((f) => f.column === 'key');
    return keyFilter && typeof keyFilter.value === 'string' ? keyFilter.value : null;
  }

  /** Minimal Redis-style glob match (`*` and `?`). */
  private globMatch(glob: string, value: string): boolean {
    const re = new RegExp(
      '^' +
        glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
    return re.test(value);
  }
}
