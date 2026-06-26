import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../types';
import { SqliteAdapter } from './sqlite-adapter';

function makeConfig(file: string): ConnectionConfig {
  const now = new Date().toISOString();
  return {
    id: 'test',
    name: 'test',
    engine: 'sqlite',
    database: file,
    createdAt: now,
    updatedAt: now,
  };
}

describe('SqliteAdapter', () => {
  let adapter: SqliteAdapter;
  let file: string;

  beforeEach(async () => {
    file = join(tmpdir(), `data-bridge-test-${Date.now()}-${Math.random()}.db`);
    adapter = new SqliteAdapter(makeConfig(file));
    await adapter.connect();
    await adapter.query(
      `CREATE TABLE users (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         email TEXT,
         active INTEGER DEFAULT 1
       )`,
    );
    await adapter.insertRow({
      table: 'users',
      values: { name: 'Ada', email: 'ada@example.com' },
    });
    await adapter.insertRow({
      table: 'users',
      values: { name: 'Linus', email: 'linus@example.com' },
    });
  });

  afterEach(async () => {
    await adapter.close();
    try {
      rmSync(file);
    } catch {
      /* ignore */
    }
  });

  it('introspects the schema with primary keys', async () => {
    const schema = await adapter.getSchema();
    const table = schema.namespaces[0]?.tables.find((t) => t.name === 'users');
    expect(table).toBeDefined();
    expect(table?.primaryKey).toEqual(['id']);
    expect(table?.columns.map((c) => c.name)).toContain('email');
  });

  it('browses with sorting and reports the total', async () => {
    const result = await adapter.browse({
      table: 'users',
      limit: 10,
      offset: 0,
      sort: [{ column: 'name', direction: 'asc' }],
    });
    expect(result.total).toBe(2);
    expect(result.rows[0]?.name).toBe('Ada');
    expect(result.primaryKey).toEqual(['id']);
  });

  it('updates and deletes by primary-key identity', async () => {
    await adapter.updateRow({
      table: 'users',
      identity: { id: 1 },
      changes: { name: 'Ada Lovelace' },
    });
    let result = await adapter.browse({ table: 'users', limit: 10, offset: 0 });
    expect(result.rows.find((r) => r.id === 1)?.name).toBe('Ada Lovelace');

    await adapter.deleteRow({ table: 'users', identity: { id: 2 } });
    result = await adapter.browse({ table: 'users', limit: 10, offset: 0 });
    expect(result.total).toBe(1);
  });

  it('is immune to SQL injection via filter values (parameterized)', async () => {
    // a classic injection payload should be treated as a literal string value,
    // not executed. the table must survive and just match zero rows
    const result = await adapter.browse({
      table: 'users',
      limit: 10,
      offset: 0,
      filters: [
        { column: 'name', operator: 'eq', value: "x'; DROP TABLE users;--" },
      ],
    });
    expect(result.rows).toHaveLength(0);

    // proof the table still exists and is intact
    const after = await adapter.browse({ table: 'users', limit: 10, offset: 0 });
    expect(after.total).toBe(2);
  });

  it('applies contains filters case-insensitively', async () => {
    const result = await adapter.browse({
      table: 'users',
      limit: 10,
      offset: 0,
      filters: [{ column: 'email', operator: 'contains', value: 'EXAMPLE' }],
    });
    expect(result.rows).toHaveLength(2);
  });

  it('upserts idempotently keyed by a unique column (bridge sink)', async () => {
    // first upsert inserts a new row
    await adapter.upsertRow({
      table: 'users',
      values: { id: 10, name: 'Grace', email: 'grace@x.com' },
      keyColumns: ['id'],
    });
    let res = await adapter.browse({ table: 'users', limit: 50, offset: 0 });
    expect(res.total).toBe(3);

    // re-running the SAME upsert must NOT create a duplicate (exactly-once)
    await adapter.upsertRow({
      table: 'users',
      values: { id: 10, name: 'Grace', email: 'grace@x.com' },
      keyColumns: ['id'],
    });
    res = await adapter.browse({ table: 'users', limit: 50, offset: 0 });
    expect(res.total).toBe(3);

    // an upsert with the same key but changed values updates in place
    await adapter.upsertRow({
      table: 'users',
      values: { id: 10, name: 'Grace Hopper', email: 'grace@x.com' },
      keyColumns: ['id'],
    });
    res = await adapter.browse({ table: 'users', limit: 50, offset: 0 });
    expect(res.total).toBe(3);
    expect(res.rows.find((r) => r.id === 10)?.name).toBe('Grace Hopper');
  });
});
