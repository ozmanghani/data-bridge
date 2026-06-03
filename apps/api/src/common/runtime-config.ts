/** Server runtime configuration, resolved once from the environment. */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveDataDir(): string {
  const dir = process.env.RELAY_DATA_DIR
    ? resolve(process.env.RELAY_DATA_DIR)
    : resolve(process.cwd(), '.relay');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const dataDir = resolveDataDir();

export const runtimeConfig = {
  dataDir,
  storeFile: resolve(dataDir, 'relay.db'),
  keyFile: resolve(dataDir, 'master.key'),
  masterKey: process.env.RELAY_MASTER_KEY ?? null,
  maxQueryRows: Number(process.env.RELAY_MAX_QUERY_ROWS ?? 5000),
  poolIdleMs: Number(process.env.RELAY_POOL_IDLE_MS ?? 300_000),
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? true,
  /** Redis URL backing the BullMQ hook-run queue. */
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /** Worker concurrency: how many hook runs may execute in parallel. */
  hookConcurrency: Number(process.env.RELAY_HOOK_CONCURRENCY ?? 5),
} as const;

/**
 * Parse {@link runtimeConfig.redisUrl} into ioredis connection options for
 * BullMQ. `maxRetriesPerRequest: null` is required by BullMQ's blocking
 * connections; ioredis still reconnects in the background, so a missing Redis
 * never crashes bootstrap — only enqueuing a run fails (with a clear message).
 */
export function redisConnectionOptions(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  maxRetriesPerRequest: null;
} {
  const u = new URL(runtimeConfig.redisUrl);
  const db = u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  return {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null,
  };
}
