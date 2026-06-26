/** SQLite adapter backed by `better-sqlite3` (synchronous, single file) */
import Database from 'better-sqlite3';
import type {
  AdapterCapabilities,
  ColumnSchema,
  CreateTableSpec,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  QueryResult,
  TableSchema,
} from '../types';
import { ConnectionError, QueryError, UnsupportedError } from '../../errors';
import { assertSafeIdentifier, BaseSqlAdapter } from './base-sql-adapter';

/**
 * better-sqlite3 only binds numbers, strings, bigints, buffers and null. coerce
 * the richer values that flow in from other engines (booleans, Dates, JSON
 * objects) into a storable scalar so a cross-engine bridge into SQLite works.
 */
function coerceSqliteParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export const SQLITE_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'sql',
  schemas: false,
  multipleDatabases: false,
  foreignKeys: true,
  rowEditing: true,
  transactions: true,
  ddl: true,
  manageDatabases: false,
  backupFormats: ['json', 'sql'],
};

export class SqliteAdapter extends BaseSqlAdapter {
  readonly engine = 'sqlite' as const;
  readonly capabilities = SQLITE_CAPABILITIES;

  private db: Database.Database | null = null;

  private getDb(): Database.Database {
    if (this.db) return this.db;
    const file = this.config.database ?? this.config.connectionString;
    if (!file) {
      throw new ConnectionError('SQLite requires a database file path');
    }
    try {
      this.db = new Database(file, { fileMustExist: false });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      return this.db;
    } catch (err) {
      throw new ConnectionError(
        `Could not open SQLite database: ${(err as Error).message}`,
      );
    }
  }

  async connect(): Promise<void> {
    this.getDb();
  }

  async ping(): Promise<void> {
    this.getDb().prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  protected override quoteIdent(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  protected override placeholder(): string {
    return '?';
  }

  protected override async runSql(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    const db = this.getDb();
    const started = performance.now();
    const bound = params.map(coerceSqliteParam);
    try {
      const stmt = db.prepare(sql);
      const isSelect = stmt.reader;
      if (isSelect) {
        const rows = stmt.all(...(bound as never[])) as Array<
          Record<string, unknown>
        >;
        const columns = (stmt.columns?.() ?? []).map((c) => ({
          name: c.name,
          dataType: c.type ?? undefined,
        }));
        return {
          columns:
            columns.length > 0
              ? columns
              : rows[0]
                ? Object.keys(rows[0]).map((name) => ({ name }))
                : [],
          rows,
          rowCount: rows.length,
          executionMs: Math.round(performance.now() - started),
          command: 'SELECT',
        };
      }
      const info = stmt.run(...(bound as never[]));
      return {
        columns: [],
        rows: [],
        rowCount: info.changes,
        affectedRows: info.changes,
        executionMs: Math.round(performance.now() - started),
        command: sql.trim().split(/\s+/)[0]?.toUpperCase(),
      };
    } catch (err) {
      throw new QueryError((err as Error).message, { sql });
    }
  }

  async listDatabases(): Promise<string[]> {
    return [this.config.database ?? 'main'];
  }

  async getSchema(): Promise<DatabaseSchema> {
    const db = this.getDb();
    const objects = db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string }>;

    const tables: TableSchema[] = [];
    for (const obj of objects) {
      const cols = db
        .prepare(`PRAGMA table_info(${this.quoteIdent(obj.name)})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      const fkRows = db
        .prepare(`PRAGMA foreign_key_list(${this.quoteIdent(obj.name)})`)
        .all() as Array<{ from: string; to: string; table: string }>;

      const fkByCol = new Map<string, { table: string; column: string }>();
      const foreignKeys: ForeignKeySchema[] = fkRows.map((r, i) => {
        fkByCol.set(r.from, { table: r.table, column: r.to });
        return {
          name: `fk_${obj.name}_${i}`,
          columns: [r.from],
          referencedTable: r.table,
          referencedColumns: [r.to],
        };
      });

      const idxRows = db
        .prepare(`PRAGMA index_list(${this.quoteIdent(obj.name)})`)
        .all() as Array<{ name: string; unique: number; origin: string }>;
      const indexes: IndexSchema[] = idxRows.map((ix) => {
        const info = db
          .prepare(`PRAGMA index_info(${this.quoteIdent(ix.name)})`)
          .all() as Array<{ name: string }>;
        return {
          name: ix.name,
          columns: info.map((c) => c.name),
          unique: ix.unique === 1,
          primary: ix.origin === 'pk',
        };
      });

      const columns: ColumnSchema[] = cols.map((c) => ({
        name: c.name,
        dataType: c.type || 'BLOB',
        nullable: c.notnull === 0,
        isPrimaryKey: c.pk > 0,
        isUnique: false,
        isAutoIncrement:
          c.pk > 0 && /INTEGER/i.test(c.type) && cols.filter((x) => x.pk > 0).length === 1,
        defaultValue: c.dflt_value != null ? String(c.dflt_value) : null,
        comment: null,
        references: fkByCol.get(c.name) ?? null,
      }));

      tables.push({
        name: obj.name,
        kind: obj.type === 'view' ? 'view' : 'table',
        columns,
        indexes,
        foreignKeys,
        primaryKey: cols.filter((c) => c.pk > 0).map((c) => c.name),
        estimatedRows: null,
        comment: null,
      });
    }

    return {
      database: this.config.database ?? 'main',
      namespaces: [{ name: '', tables }],
    };
  }

  /** SQLite needs the auto-increment PK declared inline */
  override async createTable(spec: CreateTableSpec): Promise<void> {
    if (!spec.columns.length) {
      throw new QueryError('A table needs at least one column');
    }
    const aiPk = spec.columns.find((c) => c.autoIncrement && c.primaryKey);
    const parts = spec.columns.map((c) => {
      const name = this.quoteIdent(assertSafeIdentifier(c.name));
      if (c === aiPk) return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
      let sql = `${name} ${this.validateType(c.type)}`;
      if (!c.nullable) sql += ' NOT NULL';
      if (c.unique && !c.primaryKey) sql += ' UNIQUE';
      if (c.defaultValue && c.defaultValue.trim()) {
        sql += ` DEFAULT ${c.defaultValue.trim()}`;
      }
      return sql;
    });
    const pk = spec.columns
      .filter((c) => c.primaryKey && c !== aiPk)
      .map((c) => this.quoteIdent(c.name));
    if (pk.length) parts.push(`PRIMARY KEY (${pk.join(', ')})`);
    await this.runSql(
      `CREATE TABLE ${this.quoteIdent(assertSafeIdentifier(spec.table))} (${parts.join(', ')})`,
      [],
    );
  }

  override async truncateTable(table: string): Promise<void> {
    // SQLite has no TRUNCATE; DELETE is the equivalent
    await this.runSql(`DELETE FROM ${this.quoteIdent(table)}`, []);
  }

  override async createDatabase(): Promise<void> {
    throw new UnsupportedError(
      'SQLite is a single-file database; create a new connection instead.',
    );
  }

  override async dropDatabase(): Promise<void> {
    throw new UnsupportedError('SQLite does not support dropping databases.');
  }
}
