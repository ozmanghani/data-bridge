/**
 * Payload templating for automation hooks. Pure and framework-agnostic so it
 * runs identically in the API runner and in the web preview — and is trivially
 * unit-testable.
 *
 * A template is a **JSON document** with `{{token}}` placeholders. We parse it
 * to a JSON tree exactly once and substitute tokens at the node level:
 *
 *   - A string node that is *entirely* one token (`"{{email}}"`) is replaced by
 *     the token's real value, preserving its type (number, object, null, …).
 *   - A string node containing tokens among other text (`"id-{{id}}"`) has each
 *     token stringified and interpolated, staying a string.
 *
 * Because substitution happens on the parsed tree (never by splicing raw values
 * into template text and re-parsing), a value containing quotes or newlines can
 * never break out of its position or produce invalid JSON. This is the key
 * difference from naive string interpolation, which is an injection bug.
 *
 * Tokens:
 *   {{column}}  — a column value from the source row (original, pre-rename)
 *   {{$row}}    — the projected row object (after `fields` filter + `rename`)
 *   {{$table}}  — the source table/relation name
 *   {{$now}}    — ISO timestamp captured once per delivery
 *   {{$index}}  — 0-based row index across the whole run
 */
import { BadRequestError } from '../errors';

export interface TransformContext {
  /** Resolves `{{$table}}`. */
  table: string;
  /** Resolves `{{$now}}` — captured once per delivery. */
  now: string;
  /** Resolves `{{$index}}` — 0-based row index across the run. */
  index: number;
}

export interface TransformConfig {
  /** JSON template with `{{token}}` placeholders. */
  template: string;
  /** Whitelist of source columns kept in `{{$row}}` (default: all). */
  fields?: string[];
  /** Map of source column → output key, applied to `{{$row}}`. */
  rename?: Record<string, string>;
  /** When set, the final body is wrapped as `{ [wrapKey]: body }`. */
  wrapKey?: string;
}

export interface RenderResult {
  /** The request body value (the caller is responsible for JSON.stringify). */
  body: unknown;
  /** Tokens that did not resolve — surfaced for preview, never fatal. */
  warnings: string[];
}

type Row = Record<string, unknown>;

const WHOLE_TOKEN = /^\{\{\s*([\w$]+)\s*\}\}$/;
const ANY_TOKEN = /\{\{\s*([\w$]+)\s*\}\}/g;

/** Apply the `fields` whitelist and `rename` map to produce `{{$row}}`. */
function projectRow(row: Row, cfg: TransformConfig): Row {
  let entries = Object.entries(row);
  if (cfg.fields && cfg.fields.length > 0) {
    const keep = new Set(cfg.fields);
    entries = entries.filter(([k]) => keep.has(k));
  }
  if (cfg.rename) {
    entries = entries.map(([k, v]) => [cfg.rename![k] ?? k, v]);
  }
  return Object.fromEntries(entries);
}

function buildScope(row: Row, cfg: TransformConfig, ctx: TransformContext): Row {
  return {
    ...row,
    $row: projectRow(row, cfg),
    $table: ctx.table,
    $now: ctx.now,
    $index: ctx.index,
  };
}

/** Coerce a resolved value to its string form for in-string interpolation. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Recursively substitute tokens in a parsed JSON node. */
function substitute(node: unknown, scope: Row, warnings: Set<string>): unknown {
  if (typeof node === 'string') {
    const whole = node.match(WHOLE_TOKEN);
    if (whole) {
      const name = whole[1]!;
      if (name in scope) return scope[name];
      warnings.add(name);
      return null;
    }
    return node.replace(ANY_TOKEN, (_m, name: string) => {
      if (name in scope) return stringify(scope[name]);
      warnings.add(name);
      return '';
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => substitute(item, scope, warnings));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // Keys are interpolated (string-only); values are fully substituted.
      const renderedKey = key.replace(ANY_TOKEN, (_m, name: string) => {
        if (name in scope) return stringify(scope[name]);
        warnings.add(name);
        return '';
      });
      out[renderedKey] = substitute(value, scope, warnings);
    }
    return out;
  }
  return node;
}

/**
 * Parse a template once, surfacing a clear error on malformed JSON. A template
 * that is a single bare token (e.g. the default `{{$row}}`) is returned as that
 * token string so `substitute` resolves it to a typed value — it need not be
 * quoted JSON.
 */
function parseTemplate(template: string): unknown {
  const trimmed = template.trim();
  if (WHOLE_TOKEN.test(trimmed)) return trimmed;
  try {
    return JSON.parse(template);
  } catch (err) {
    throw new BadRequestError(
      `Payload template is not valid JSON: ${(err as Error).message}`,
    );
  }
}

/** Render a single row to a request body. */
export function renderRow(
  row: Row,
  cfg: TransformConfig,
  ctx: TransformContext,
): RenderResult {
  const warnings = new Set<string>();
  const tree = parseTemplate(cfg.template);
  const rendered = substitute(tree, buildScope(row, cfg, ctx), warnings);
  return { body: wrap(rendered, cfg), warnings: [...warnings] };
}

/**
 * Render N rows into a single array body (used when `batchSize > 1`). Each row
 * is rendered with its own `{{$index}}`; the optional `wrapKey` wraps the array.
 */
export function renderBatch(
  rows: Row[],
  cfg: TransformConfig,
  startIndex: number,
  ctx: Omit<TransformContext, 'index'>,
): RenderResult {
  const warnings = new Set<string>();
  const tree = parseTemplate(cfg.template);
  const items = rows.map((row, i) => {
    const scope = buildScope(row, cfg, { ...ctx, index: startIndex + i });
    return substitute(tree, scope, warnings);
  });
  return { body: wrap(items, cfg), warnings: [...warnings] };
}

function wrap(body: unknown, cfg: TransformConfig): unknown {
  return cfg.wrapKey ? { [cfg.wrapKey]: body } : body;
}
