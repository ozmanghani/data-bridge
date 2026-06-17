/**
 * Shared Zod schemas + types for automation hooks. Used by the API (validation,
 * persistence) and the web client (forms, preview) — so the contract lives in
 * exactly one place, mirroring `validation.ts`.
 */
import { z } from 'zod';
import { filterSchema, sortSchema } from '../validation';

/* -------------------------------------------------------------------------- */
/* Source — where rows are read from                                          */
/* -------------------------------------------------------------------------- */

const tableSourceSchema = z.object({
  kind: z.literal('table'),
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().min(1),
  filters: z.array(filterSchema).optional(),
  sort: z.array(sortSchema).optional(),
});

const querySourceSchema = z.object({
  kind: z.literal('query'),
  connectionId: z.string().min(1),
  database: z.string().optional(),
  statement: z.string().min(1),
});

export const hookSourceSchema = z.discriminatedUnion('kind', [
  tableSourceSchema,
  querySourceSchema,
]);

/* -------------------------------------------------------------------------- */
/* Destination — where rows are sent                                          */
/* -------------------------------------------------------------------------- */

export const hookAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('header'), name: z.string().min(1), value: z.string() }),
]);

export const hookDestinationSchema = z.object({
  url: z.string().url('Enter a valid http(s) URL'),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  auth: hookAuthSchema.default({ type: 'none' }),
  /**
   * Add an `Idempotency-Key` header derived from `(runId, sequence)` so the
   * receiver can dedupe at-least-once redeliveries (see runner docs).
   */
  idempotency: z.boolean().default(false),
});

/* -------------------------------------------------------------------------- */
/* Transform — how each row becomes a body                                    */
/* -------------------------------------------------------------------------- */

export const hookTransformSchema = z.object({
  template: z.string().min(1).default('{{$row}}'),
  fields: z.array(z.string()).optional(),
  rename: z.record(z.string(), z.string()).optional(),
  wrapKey: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Delivery — pacing, retries, batching                                       */
/* -------------------------------------------------------------------------- */

export const hookDeliverySchema = z.object({
  /** Rows per HTTP request. 1 = strictly one-by-one. */
  batchSize: z.coerce.number().int().min(1).max(1000).default(1),
  /** Total attempts per request (1 = no retry). */
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  /** Base backoff in ms; doubles each retry up to `backoffMaxMs`. */
  backoffMs: z.coerce.number().int().min(0).max(60_000).default(500),
  backoffMaxMs: z.coerce.number().int().min(0).max(300_000).default(30_000),
  /** Minimum delay between requests (rate limit). */
  minDelayMs: z.coerce.number().int().min(0).max(600_000).default(0),
  /** Per-request timeout. */
  timeoutMs: z.coerce.number().int().min(100).max(120_000).default(15_000),
  /** Rows fetched per page from a table source. */
  pageSize: z.coerce.number().int().min(1).max(1000).default(200),
  /** Whether a failed delivery aborts the run or is logged and skipped. */
  onError: z.enum(['continue', 'abort']).default('continue'),
});

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Trigger — when the hook runs                                               */
/* -------------------------------------------------------------------------- */

export const watchStrategySchema = z.discriminatedUnion('strategy', [
  // Track a strictly-increasing column (auto-increment id / sequence).
  z.object({ strategy: z.literal('increment'), column: z.string().min(1) }),
  // Track a created_at / updated_at column.
  z.object({ strategy: z.literal('timestamp'), column: z.string().min(1) }),
  // Diff the set of seen primary keys (for UUID / non-monotonic keys).
  z.object({
    strategy: z.literal('snapshot'),
    maxTracked: z.coerce.number().int().min(100).max(200_000).default(50_000),
  }),
]);

export const cdcOperationSchema = z.enum(['insert', 'update', 'delete']);

export const hookTriggerSchema = z.discriminatedUnion('kind', [
  // Run on demand (replay the source when you press Run).
  z.object({ kind: z.literal('replay') }),
  // Continuously poll the source for new rows and deliver them live.
  z.object({
    kind: z.literal('watch'),
    strategy: watchStrategySchema,
    pollIntervalMs: z.coerce.number().int().min(1000).max(3_600_000).default(5000),
    /** `now` ignores existing rows and only delivers ones added after start. */
    startFrom: z.enum(['beginning', 'now']).default('now'),
    /** Max rows delivered per poll cycle (backpressure). */
    maxPerPoll: z.coerce.number().int().min(1).max(5000).default(500),
  }),
  // Event-based: stream changes from the database's change log (CDC).
  // Real-time, no polling. Mechanism depends on the engine: Postgres logical
  // replication, MySQL binlog, MongoDB change streams, or Redis keyspace
  // notifications. Requirements (and a readiness probe) are surfaced per engine;
  // any server-side objects (e.g. Postgres publication/slot) are auto-provisioned.
  z.object({
    kind: z.literal('cdc'),
    operations: z.array(cdcOperationSchema).min(1).default(['insert', 'update', 'delete']),
  }),
]);

export const hookInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  source: hookSourceSchema,
  destination: hookDestinationSchema,
  transform: hookTransformSchema,
  delivery: hookDeliverySchema.default({}),
  trigger: hookTriggerSchema.default({ kind: 'replay' }),
  enabled: z.boolean().default(true),
});

export const hookPreviewSchema = z.object({
  /** Render against this row instead of fetching from the source. */
  sampleRow: z.record(z.string(), z.unknown()).optional(),
  /** When no sampleRow is given, fetch this many rows from the source. */
  limit: z.coerce.number().int().min(1).max(10).default(3),
});

export const startRunSchema = z.object({
  /** Resume a previously interrupted run instead of starting fresh. */
  resumeRunId: z.string().optional(),
  /** Start a specific prepared (draft) run. */
  runId: z.string().optional(),
  /** Create a new run that re-sends only the failed rows of this run. */
  retryFailedOf: z.string().optional(),
});

export const skipSchema = z.object({
  /** Delivery sequence numbers to skip (only effective while still queued). */
  sequences: z.array(z.coerce.number().int().min(0)).min(1).max(10_000),
});

/** Check whether a connection+table can do event-based (CDC) delivery. */
export const cdcReadinessSchema = z.object({
  connectionId: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Inferred types + DTOs surfaced to the web client                           */
/* -------------------------------------------------------------------------- */

export type HookSource = z.infer<typeof hookSourceSchema>;
export type HookAuth = z.infer<typeof hookAuthSchema>;
export type HookDestination = z.infer<typeof hookDestinationSchema>;
export type HookTransformConfig = z.infer<typeof hookTransformSchema>;
export type HookDeliveryConfig = z.infer<typeof hookDeliverySchema>;
export type HookTrigger = z.infer<typeof hookTriggerSchema>;
export type WatchStrategyConfig = z.infer<typeof watchStrategySchema>;
export type CdcOperation = z.infer<typeof cdcOperationSchema>;
export type CdcReadinessDTO = z.infer<typeof cdcReadinessSchema>;
export type HookInputDTO = z.infer<typeof hookInputSchema>;

/** Result of a CDC readiness probe — drives the builder's setup panel. */
export interface CdcReadiness {
  engine: string;
  /** Whether this engine has an event-based path implemented at all. */
  supported: boolean;
  /** Whether the DB is configured and ready to stream right now. */
  ready: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
  /** Manual steps the user must do (e.g. set wal_level=logical + restart). */
  instructions: string[];
}
export type HookPreviewDTO = z.infer<typeof hookPreviewSchema>;
export type StartRunDTO = z.infer<typeof startRunSchema>;
export type SkipDTO = z.infer<typeof skipSchema>;

export type HookRunStatus =
  | 'draft' // prepared & queued in the UI, not yet sending
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceling'
  | 'canceled'
  | 'paused' // stopped by the user; resumable in place (same run)
  | 'interrupted';

export type DeliveryStatus = 'success' | 'failed' | 'skipped';

/** The hook as returned by the API (secret redacted). */
export interface Hook {
  id: string;
  name: string;
  source: HookSource;
  destination: HookDestination;
  transform: HookTransformConfig;
  delivery: HookDeliveryConfig;
  trigger: HookTrigger;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HookRun {
  id: string;
  hookId: string;
  status: HookRunStatus;
  cursorOffset: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  totalCount: number | null;
  /** Batch size from the config snapshot used to create this run. */
  batchSize: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface HookDelivery {
  id: string;
  runId: string;
  sequence: number;
  rowIndex: number;
  rowCount: number;
  status: DeliveryStatus;
  httpStatus: number | null;
  attempts: number;
  error: string | null;
  /** The exact JSON body sent for this delivery (capped). */
  requestBody: string | null;
  /** The full response text returned by the endpoint (capped). */
  responseBody: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** Result of the preview endpoint: rendered bodies + resolved request shape. */
export interface HookPreview {
  method: string;
  url: string;
  /** Headers with any auth secret redacted. */
  headers: Record<string, string>;
  /** One rendered body per sample row (or per batch when batched). */
  bodies: unknown[];
  warnings: string[];
  /** True when the rows came from the live source rather than a sample. */
  fromSource: boolean;
}
