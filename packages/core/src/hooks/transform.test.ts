import { describe, expect, it } from 'vitest';
import { renderBatch, renderRow, type TransformContext } from './transform';

const ctx: TransformContext = {
  table: 'users',
  now: '2026-06-03T00:00:00.000Z',
  index: 7,
};

describe('renderRow', () => {
  it('passes through the projected row via {{$row}}', () => {
    const { body, warnings } = renderRow(
      { id: 1, email: 'a@b.com' },
      { template: '{{$row}}' },
      ctx,
    );
    expect(body).toEqual({ id: 1, email: 'a@b.com' });
    expect(warnings).toEqual([]);
  });

  it('preserves value types for whole-token string nodes', () => {
    const { body } = renderRow(
      { id: 42, active: true, meta: { a: 1 }, nada: null },
      {
        template:
          '{"id":"{{id}}","active":"{{active}}","meta":"{{meta}}","nada":"{{nada}}"}',
      },
      ctx,
    );
    // Whole-token strings adopt the real JS type, not a string.
    expect(body).toEqual({ id: 42, active: true, meta: { a: 1 }, nada: null });
  });

  it('interpolates tokens inside larger strings (stringified)', () => {
    const { body } = renderRow(
      { id: 5 },
      { template: '{"ref":"order-{{id}}-{{$index}}"}' },
      ctx,
    );
    expect(body).toEqual({ ref: 'order-5-7' });
  });

  it('resolves $table, $now and $index helpers', () => {
    const { body } = renderRow(
      { id: 1 },
      { template: '{"t":"{{$table}}","at":"{{$now}}","i":"{{$index}}"}' },
      ctx,
    );
    expect(body).toEqual({ t: 'users', at: ctx.now, i: 7 });
  });

  it('is injection-safe: values with quotes/newlines cannot break JSON', () => {
    const { body } = renderRow(
      { note: 'he said "hi"\n} malicious", "admin":true' },
      { template: '{"note":"{{note}}"}' },
      ctx,
    );
    expect(body).toEqual({ note: 'he said "hi"\n} malicious", "admin":true' });
    expect((body as { admin?: unknown }).admin).toBeUndefined();
  });

  it('applies fields whitelist and rename to {{$row}}', () => {
    const { body } = renderRow(
      { id: 1, email: 'a@b.com', password: 'secret' },
      {
        template: '{{$row}}',
        fields: ['id', 'email'],
        rename: { email: 'contact' },
      },
      ctx,
    );
    expect(body).toEqual({ id: 1, contact: 'a@b.com' });
  });

  it('wraps the body under wrapKey', () => {
    const { body } = renderRow(
      { id: 1 },
      { template: '{{$row}}', wrapKey: 'data' },
      ctx,
    );
    expect(body).toEqual({ data: { id: 1 } });
  });

  it('collects warnings for unknown tokens without throwing', () => {
    const { body, warnings } = renderRow(
      { id: 1 },
      { template: '{"x":"{{missing}}"}' },
      ctx,
    );
    expect(body).toEqual({ x: null });
    expect(warnings).toEqual(['missing']);
  });

  it('throws a clear error on malformed template JSON', () => {
    expect(() => renderRow({ id: 1 }, { template: '{not json' }, ctx)).toThrow(
      /not valid JSON/i,
    );
  });
});

describe('renderBatch', () => {
  it('renders an array with per-row $index', () => {
    const { body } = renderBatch(
      [{ id: 1 }, { id: 2 }],
      { template: '{"id":"{{id}}","i":"{{$index}}"}' },
      10,
      { table: 'users', now: ctx.now },
    );
    expect(body).toEqual([
      { id: 1, i: 10 },
      { id: 2, i: 11 },
    ]);
  });

  it('wraps the whole array under wrapKey', () => {
    const { body } = renderBatch(
      [{ id: 1 }, { id: 2 }],
      { template: '{{$row}}', wrapKey: 'records' },
      0,
      { table: 'users', now: ctx.now },
    );
    expect(body).toEqual({ records: [{ id: 1 }, { id: 2 }] });
  });
});
