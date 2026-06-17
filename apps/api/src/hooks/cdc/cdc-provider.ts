/**
 * CDC provider abstraction.
 *
 * Each database engine captures changes a different way — Postgres logical
 * replication, MySQL binlog, MongoDB change streams, Redis keyspace
 * notifications — but they all feed the SAME downstream pipeline: render the
 * row, deliver it over HTTP, record the delivery, persist a resume cursor.
 *
 * A `CdcProvider` isolates the engine-specific "how do I get a stream of
 * changes" behind a small interface. {@link HookCdcService} is the engine-
 * agnostic orchestrator: it picks a provider, owns the run lifecycle, and
 * implements the shared per-change handler (dedupe → render → send → record →
 * persist cursor). Providers never touch the database metadata store or the
 * delivery service — they only emit normalized {@link CdcChange}s.
 */
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@relay/core';
import type { ResolvedHook } from '../hooks.types';

/** One decoded change, normalized across every engine. */
export interface CdcChange {
  /** insert | update | delete */
  op: CdcOperation;
  /** Row/document/value after the change (before-image for deletes). */
  row: Record<string, unknown>;
  /**
   * Opaque, engine-specific position string used BOTH as the resume cursor and
   * the idempotency seed. Postgres: LSN "H/L"; MySQL: "file:pos"; MongoDB:
   * serialized resumeToken; Redis: synthetic, non-durable. The orchestrator
   * persists it verbatim and hands it back on resume.
   */
  cursor: string;
}

/** Callbacks the orchestrator hands to a provider's live stream. */
export interface CdcStreamHandlers {
  /**
   * Deliver one change. The orchestrator dedupes, renders, sends, records, and
   * persists the cursor. Providers MUST `await` this before reading the next
   * event so backpressure flows all the way to the source.
   */
  onChange(change: CdcChange): Promise<void>;
  /** A non-fatal transport error. Logged; the provider keeps/reconnects. */
  onError(err: Error): void;
}

/** Everything a provider needs to open a stream. */
export interface CdcStreamContext {
  hookId: string;
  hook: ResolvedHook;
  conn: ConnectionConfig;
  /** Last persisted cursor (resume point), or null to start from "now". */
  fromCursor: string | null;
  handlers: CdcStreamHandlers;
}

/** A handle to a running stream so the orchestrator can stop it cleanly. */
export interface CdcStreamHandle {
  stop(): Promise<void>;
}

export interface CdcProvider {
  readonly engine: DatabaseEngine;

  /**
   * Can this engine/connection stream changes right now? Drives the builder's
   * setup panel. MUST NOT throw — fold connection failures into a failing check.
   * Engines with no event path (sqlite) return `supported: false`.
   */
  readiness(dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness>;

  /**
   * Create any durable server-side objects needed to capture changes
   * (Postgres: publication + replication slot). Idempotent; safe on resume.
   * Most engines have nothing to provision (the binlog/oplog/keyspace stream
   * already exists) and implement this as a no-op.
   */
  provision(hookId: string, hook: ResolvedHook, conn: ConnectionConfig): Promise<void>;

  /**
   * Drop everything {@link provision} created. Called only on hook delete.
   * Must never throw fatally.
   */
  deprovision(hookId: string, hook: ResolvedHook, conn: ConnectionConfig): Promise<void>;

  /** Open the long-lived connection and start emitting changes. */
  startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle>;

  /**
   * True if cursor `a` is strictly after watermark `b` — used by the
   * orchestrator to drop replays after a reconnect. Engines whose driver
   * resumes exactly (Mongo resumeToken, Redis fire-and-forget) return `true`.
   */
  cursorAfter(a: string, b: string | null): boolean;
}

/** DI token for the set of registered providers. */
export const CDC_PROVIDERS = Symbol('CDC_PROVIDERS');

/* -------------------------------------------------------------------------- */
/* Small shared helpers usable by any provider                                */
/* -------------------------------------------------------------------------- */

/** Sleep that resolves after `ms`, used by reconnect backoff loops. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with a cap, for stream reconnect loops.
 * attempt 0 → base, doubling each time, clamped to `cap`.
 */
export function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt));
}

/** A type for the per-engine `op` set check, shared by row-event providers. */
export function opEnabled(op: CdcOperation, enabled: Set<CdcOperation>): boolean {
  return enabled.has(op);
}
