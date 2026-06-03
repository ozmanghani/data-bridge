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

export const hookInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  source: hookSourceSchema,
  destination: hookDestinationSchema,
  transform: hookTransformSchema,
  delivery: hookDeliverySchema.default({}),
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
});

/* -------------------------------------------------------------------------- */
/* Inferred types + DTOs surfaced to the web client                           */
/* -------------------------------------------------------------------------- */

export type HookSource = z.infer<typeof hookSourceSchema>;
export type HookAuth = z.infer<typeof hookAuthSchema>;
export type HookDestination = z.infer<typeof hookDestinationSchema>;
export type HookTransformConfig = z.infer<typeof hookTransformSchema>;
export type HookDeliveryConfig = z.infer<typeof hookDeliverySchema>;
export type HookInputDTO = z.infer<typeof hookInputSchema>;
export type HookPreviewDTO = z.infer<typeof hookPreviewSchema>;
export type StartRunDTO = z.infer<typeof startRunSchema>;

export type HookRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceling'
  | 'canceled'
  | 'interrupted';

export type DeliveryStatus = 'success' | 'failed';

/** The hook as returned by the API (secret redacted). */
export interface Hook {
  id: string;
  name: string;
  source: HookSource;
  destination: HookDestination;
  transform: HookTransformConfig;
  delivery: HookDeliveryConfig;
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
  totalCount: number | null;
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
  responseSnippet: string | null;
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
