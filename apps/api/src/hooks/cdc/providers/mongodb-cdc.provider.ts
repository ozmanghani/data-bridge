/**
 * MongoDB CDC via **change streams** (`collection.watch()`), built on the oplog.
 * Real-time, durable, and resumable via a resume token — as long as the token
 * still falls inside the oplog window. Requires the server to be a replica set
 * (a single-node replica set works for dev) or a sharded cluster; change streams
 * are unavailable on a standalone mongod.
 *
 * Resume token (`change._id`) is serialized into the cursor. On a long pause the
 * oplog can roll past the token (`ChangeStreamHistoryLost`); we catch that,
 * warn, and restart from "now" rather than crash-looping.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  MongoClient,
  type ChangeStream,
  type ChangeStreamDocument,
  type Document,
} from 'mongodb';
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@relay/core';
import type { ResolvedHook } from '../../hooks.types';
import { backoffMs, delay, type CdcChange, type CdcProvider, type CdcStreamContext, type CdcStreamHandle } from '../cdc-provider';

/** Translate enabled CDC ops into the change-stream operationTypes to match. */
function operationTypes(ops: Set<CdcOperation>): string[] {
  const out: string[] = [];
  if (ops.has('insert')) out.push('insert');
  if (ops.has('update')) out.push('update', 'replace'); // replace is an update
  if (ops.has('delete')) out.push('delete');
  return out;
}

@Injectable()
export class MongodbCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'mongodb';
  private readonly logger = new Logger('HookCdc:mongo');

  // Resume tokens are exact; the driver replays from the token with no overlap.
  cursorAfter(): boolean {
    return true;
  }

  /* ----- connection ----- */

  private uri(conn: ConnectionConfig): string {
    if (conn.connectionString) return conn.connectionString;
    const auth =
      conn.user && conn.password
        ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@`
        : '';
    const host = conn.host ?? 'localhost';
    const port = conn.port ?? 27017;
    return `mongodb://${auth}${host}:${port}`;
  }

  /* ----- readiness ----- */

  async readiness(_dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness> {
    const checks: CdcReadiness['checks'] = [];
    const instructions: string[] = [];
    let client: MongoClient | null = null;
    try {
      client = new MongoClient(this.uri(conn), { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      const hello = (await client.db('admin').command({ hello: 1 })) as {
        setName?: string;
        msg?: string;
      };
      const isReplicaSet = !!hello.setName;
      const isSharded = hello.msg === 'isdbgrid';
      const ok = isReplicaSet || isSharded;
      checks.push({
        label: 'replica set or sharded cluster',
        ok,
        detail: isReplicaSet
          ? `replica set "${hello.setName}"`
          : isSharded
            ? 'sharded cluster'
            : 'standalone server',
      });
      if (!ok) {
        instructions.push(
          'MongoDB change streams require a replica set. For local dev, start mongod with `--replSet rs0` and run `rs.initiate()` once. Managed MongoDB (Atlas) already satisfies this.',
        );
      }
      return { engine: 'mongodb', supported: true, ready: ok, checks, instructions };
    } catch (err) {
      return {
        engine: 'mongodb',
        supported: true,
        ready: false,
        checks: [{ label: 'connect to MongoDB', ok: false, detail: (err as Error).message }],
        instructions: ['Could not connect to MongoDB to check readiness.'],
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  /* ----- provisioning: nothing to do (the oplog already exists) ----- */

  async provision(): Promise<void> {
    /* no-op */
  }
  async deprovision(): Promise<void> {
    /* no-op */
  }

  /* ----- the stream ----- */

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const { hook, conn, handlers, fromCursor } = ctx;
    if (hook.source.kind !== 'table' || hook.trigger.kind !== 'cdc') {
      throw new Error('MongoDB CDC requires a collection source and cdc trigger.');
    }
    const src = hook.source;
    const ops = new Set<CdcOperation>(hook.trigger.operations);
    const matchTypes = operationTypes(ops);

    const client = new MongoClient(this.uri(conn), { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(src.database || conn.database || 'test');
    const collection = db.collection(src.table);

    let stopped = false;
    let current: ChangeStream | null = null;
    let resumeToken: unknown = fromCursor ? this.parseToken(fromCursor) : null;
    let attempt = 0;

    const pipeline =
      matchTypes.length > 0 ? [{ $match: { operationType: { $in: matchTypes } } }] : [];

    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          const options: Document = { fullDocument: 'updateLookup' };
          if (resumeToken) options.startAfter = resumeToken;
          const stream = collection.watch(pipeline, options);
          current = stream;
          attempt = 0; // a successful open resets backoff

          for await (const change of stream as AsyncIterable<ChangeStreamDocument>) {
            if (stopped) break;
            const mapped = this.mapChange(change);
            if (mapped) await handlers.onChange(mapped);
            resumeToken = (change as { _id?: unknown })._id ?? resumeToken;
          }
          // Iterator ended without error (e.g. closed by stop()).
          if (stopped) break;
        } catch (err) {
          if (stopped) break;
          const e = err as Error & { codeName?: string; code?: number };
          const historyLost =
            e.codeName === 'ChangeStreamHistoryLost' || e.code === 286;
          if (historyLost) {
            handlers.onError(
              new Error(
                'Resume token is older than the MongoDB oplog window — restarting from now. Changes during the gap were not captured.',
              ),
            );
            resumeToken = null; // restart from "now"
            continue;
          }
          handlers.onError(e);
          await delay(backoffMs(attempt++));
        }
      }
    };

    // Drive the loop in the background; it owns its own lifecycle.
    void loop().catch((err) => handlers.onError(err as Error));

    return {
      stop: async () => {
        stopped = true;
        await current?.close().catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  }

  /** Map a change-stream event into the normalized shape, or null to skip. */
  private mapChange(change: ChangeStreamDocument): CdcChange | null {
    const cursor = this.serializeToken((change as { _id?: unknown })._id);
    switch (change.operationType) {
      case 'insert':
      case 'update':
      case 'replace': {
        const full = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
        // On update, the doc may have been deleted before updateLookup ran.
        const row =
          full ?? ((change as { documentKey?: Record<string, unknown> }).documentKey ?? {});
        // replace behaves like an overwrite → report it as an update.
        const op: CdcOperation = change.operationType === 'insert' ? 'insert' : 'update';
        return { op, row, cursor };
      }
      case 'delete': {
        const key = (change as { documentKey?: Record<string, unknown> }).documentKey ?? {};
        return { op: 'delete', row: key, cursor };
      }
      default:
        return null; // drop, rename, invalidate, etc.
    }
  }

  private serializeToken(token: unknown): string {
    try {
      return JSON.stringify(token);
    } catch {
      return '';
    }
  }
  private parseToken(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
}
