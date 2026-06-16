/**
 * Pure change-detection engine for "watch" hooks. Given a strategy and the
 * cursor persisted from the last poll, it produces the browse query for the
 * next poll and, from the rows that came back, the *new* rows plus the advanced
 * cursor. It performs no I/O, so it is fully unit-testable.
 *
 * Three polling strategies, each suited to a different table shape:
 *
 *  - `increment` — a strictly-increasing column (auto-increment id, sequence).
 *    `col > cursor`, ordered ascending. Exact: never misses or duplicates a row.
 *    Detects inserts only.
 *  - `timestamp` — a `created_at`/`updated_at` column. `col >= cursor` with
 *    boundary-key dedupe so rows sharing the cursor's timestamp are emitted
 *    exactly once. Detects inserts and (for `updated_at`) updates.
 *  - `snapshot` — diff the set of seen primary keys (bounded). Works when there
 *    is no monotonic cursor (e.g. UUID keys). Best for small/medium tables.
 */
import type { FilterSpec, SortSpec } from '../adapters/types';

export type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Strategy + cursor shapes                                                   */
/* -------------------------------------------------------------------------- */

export interface IncrementStrategy {
  strategy: 'increment';
  column: string;
}
export interface TimestampStrategy {
  strategy: 'timestamp';
  column: string;
}
export interface SnapshotStrategy {
  strategy: 'snapshot';
  /** Cap on tracked primary keys (bounds memory/state). */
  maxTracked: number;
}
export type WatchStrategy =
  | IncrementStrategy
  | TimestampStrategy
  | SnapshotStrategy;

export interface IncrementCursor {
  strategy: 'increment';
  value: unknown;
}
export interface TimestampCursor {
  strategy: 'timestamp';
  ts: unknown;
  /** Row keys already emitted at exactly `ts` (dedupe on the `>=` re-fetch). */
  boundaryKeys: string[];
}
export interface SnapshotCursor {
  strategy: 'snapshot';
  seen: string[];
}
export type WatchCursor = IncrementCursor | TimestampCursor | SnapshotCursor;

export interface AdvanceResult {
  newRows: Row[];
  cursor: WatchCursor;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Stable identity for a row from its primary key (falls back to all values). */
export function rowKey(row: Row, pk: string[]): string {
  const cols = pk.length > 0 ? pk : Object.keys(row).sort();
  return JSON.stringify(cols.map((c) => row[c] ?? null));
}

/** Compare two timestamp-ish values (Date | ISO string | epoch number). */
function tsEquals(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): number | string => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isNaN(t) ? v : t;
    }
    return String(v);
  };
  return norm(a) === norm(b);
}

/** A serializable form of a timestamp value for persisting in the cursor. */
function serializeTs(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

/** The cursor for a brand-new watch run that should emit from the beginning. */
export function emptyCursor(strategy: WatchStrategy): WatchCursor {
  switch (strategy.strategy) {
    case 'increment':
      return { strategy: 'increment', value: null };
    case 'timestamp':
      return { strategy: 'timestamp', ts: null, boundaryKeys: [] };
    case 'snapshot':
      return { strategy: 'snapshot', seen: [] };
  }
}

/** The browse filters + sort for the next poll, given the current cursor. */
export function watchQuery(
  strategy: WatchStrategy,
  cursor: WatchCursor,
): { filters: FilterSpec[]; sort: SortSpec[] } {
  if (strategy.strategy === 'increment' && cursor.strategy === 'increment') {
    return {
      filters:
        cursor.value != null
          ? [{ column: strategy.column, operator: 'gt', value: cursor.value }]
          : [],
      sort: [{ column: strategy.column, direction: 'asc' }],
    };
  }
  if (strategy.strategy === 'timestamp' && cursor.strategy === 'timestamp') {
    return {
      filters:
        cursor.ts != null
          ? [{ column: strategy.column, operator: 'gte', value: cursor.ts }]
          : [],
      sort: [{ column: strategy.column, direction: 'asc' }],
    };
  }
  // snapshot: scan the table (caller bounds the page size).
  return { filters: [], sort: [] };
}

/**
 * From the candidate rows returned by {@link watchQuery} (already filtered and
 * sorted ascending), return the genuinely-new rows and the advanced cursor.
 */
export function advanceCursor(
  strategy: WatchStrategy,
  cursor: WatchCursor,
  rows: Row[],
  pk: string[],
): AdvanceResult {
  if (strategy.strategy === 'increment' && cursor.strategy === 'increment') {
    // Every row is strictly greater than the cursor by query construction.
    const last = rows[rows.length - 1];
    return {
      newRows: rows,
      cursor: {
        strategy: 'increment',
        value: last ? last[strategy.column] : cursor.value,
      },
    };
  }

  if (strategy.strategy === 'timestamp' && cursor.strategy === 'timestamp') {
    const alreadyEmitted = new Set(cursor.boundaryKeys);
    const newRows = rows.filter((r) => !alreadyEmitted.has(rowKey(r, pk)));
    if (rows.length === 0) {
      return { newRows, cursor };
    }
    // Rows are sorted ascending → the last one carries the max timestamp.
    const maxTs = rows[rows.length - 1]![strategy.column];
    // All rows at the boundary timestamp are remembered so the next `>=` poll
    // can dedupe them.
    const boundaryKeys = rows
      .filter((r) => tsEquals(r[strategy.column], maxTs))
      .map((r) => rowKey(r, pk));
    return {
      newRows,
      cursor: {
        strategy: 'timestamp',
        ts: serializeTs(maxTs),
        boundaryKeys,
      },
    };
  }

  // snapshot
  const seen = new Set(cursor.strategy === 'snapshot' ? cursor.seen : []);
  const newRows: Row[] = [];
  for (const r of rows) {
    const k = rowKey(r, pk);
    if (!seen.has(k)) {
      seen.add(k);
      newRows.push(r);
    }
  }
  const max = strategy.strategy === 'snapshot' ? strategy.maxTracked : 50_000;
  let kept = [...seen];
  if (kept.length > max) kept = kept.slice(kept.length - max);
  return { newRows, cursor: { strategy: 'snapshot', seen: kept } };
}
