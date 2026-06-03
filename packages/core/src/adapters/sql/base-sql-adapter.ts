/**
 * Shared implementation for relational engines.
 *
 * Concrete SQL adapters (Postgres, MySQL, SQLite, ...) only implement the
 * connection lifecycle, schema introspection, and three small dialect
 * primitives (`quoteIdent`, `placeholder`, `runSql`). Everything user-facing —
 * browse, raw query, and row mutations — is built here ONCE, with strict
 * parameterization so no user value is ever concatenated into SQL.
 */
import type {
  AdapterCapabilities,
  BackupDocument,
  BackupFormat,
  BackupOptions,
  BrowseParams,
  BrowseResult,
  ColumnDefinition,
  ConnectionConfig,
  CreateTableSpec,
  DatabaseAdapter,
  DatabaseEngine,
  DatabaseSchema,
  DeleteRowParams,
  FilterSpec,
  InsertRowParams,
  QueryResult,
  RestoreResult,
  TableSchema,
  UpdateRowParams,
} from '../types';
import { BadRequestError } from '../../errors';

const RESTORE_BATCH = 500;

/** Reject identifiers that aren't safe to embed in DDL (which can't be bound). */
export function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new BadRequestError(
      `Invalid identifier "${name}". Use letters, digits and underscores.`,
    );
  }
  return name;
}

const DEFAULT_MAX_ROWS = 5000;

export abstract class BaseSqlAdapter implements DatabaseAdapter {
  abstract readonly engine: DatabaseEngine;
  abstract readonly capabilities: AdapterCapabilities;

  protected readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  protected get maxRows(): number {
    const fromOpts = Number(this.config.options?.maxQueryRows);
    return Number.isFinite(fromOpts) && fromOpts > 0
      ? fromOpts
      : DEFAULT_MAX_ROWS;
  }

  /* ----- lifecycle / introspection: implemented by concrete adapters ----- */
  abstract connect(): Promise<void>;
  abstract ping(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listDatabases(): Promise<string[]>;
  abstract getSchema(database?: string): Promise<DatabaseSchema>;

  /* ----- dialect primitives ----- */

  /** Quote an identifier (table/column) safely for this dialect. */
  protected abstract quoteIdent(identifier: string): string;

  /**
   * Render a positional placeholder for the n-th (1-based) parameter.
   * Postgres → `$1`, MySQL/SQLite → `?`.
   */
  protected abstract placeholder(index: number): string;

  /** Execute a parameterized statement and return a normalized result. */
  protected abstract runSql(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult>;

  /** LIKE keyword to use for case-insensitive matching (Postgres → ILIKE). */
  protected likeKeyword(): string {
    return 'LIKE';
  }

  /* ----- shared SQL building ----- */

  protected qualify(table: string, schema?: string): string {
    return schema
      ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}`
      : this.quoteIdent(table);
  }

  /**
   * Build a parameterized WHERE clause from filters.
   * Returns the SQL fragment (without leading WHERE) and bound params.
   */
  private buildWhere(
    filters: FilterSpec[] | undefined,
    startIndex: number,
  ): { clause: string; params: unknown[] } {
    if (!filters || filters.length === 0) return { clause: '', params: [] };

    const params: unknown[] = [];
    let idx = startIndex;
    const parts = filters.map((f) => {
      const col = this.quoteIdent(f.column);
      switch (f.operator) {
        case 'isNull':
          return `${col} IS NULL`;
        case 'notNull':
          return `${col} IS NOT NULL`;
        case 'eq':
          params.push(f.value);
          return `${col} = ${this.placeholder(idx++)}`;
        case 'neq':
          params.push(f.value);
          return `${col} <> ${this.placeholder(idx++)}`;
        case 'lt':
          params.push(f.value);
          return `${col} < ${this.placeholder(idx++)}`;
        case 'lte':
          params.push(f.value);
          return `${col} <= ${this.placeholder(idx++)}`;
        case 'gt':
          params.push(f.value);
          return `${col} > ${this.placeholder(idx++)}`;
        case 'gte':
          params.push(f.value);
          return `${col} >= ${this.placeholder(idx++)}`;
        case 'contains':
          params.push(`%${String(f.value ?? '')}%`);
          return `${col} ${this.likeKeyword()} ${this.placeholder(idx++)}`;
        case 'startsWith':
          params.push(`${String(f.value ?? '')}%`);
          return `${col} ${this.likeKeyword()} ${this.placeholder(idx++)}`;
        case 'endsWith':
          params.push(`%${String(f.value ?? '')}`);
          return `${col} ${this.likeKeyword()} ${this.placeholder(idx++)}`;
        default:
          throw new BadRequestError(
            `Unsupported filter operator: ${String(f.operator)}`,
          );
      }
    });

    return { clause: parts.join(' AND '), params };
  }

  async browse(params: BrowseParams): Promise<BrowseResult> {
    const limit = Math.min(Math.max(params.limit, 1), this.maxRows);
    const offset = Math.max(params.offset, 0);
    const target = this.qualify(params.table, params.schema);

    const where = this.buildWhere(params.filters, 1);
    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';

    let orderSql = '';
    if (params.sort && params.sort.length > 0) {
      orderSql =
        ' ORDER BY ' +
        params.sort
          .map(
            (s) =>
              `${this.quoteIdent(s.column)} ${
                s.direction === 'desc' ? 'DESC' : 'ASC'
              }`,
          )
          .join(', ');
    }

    // Fetch one extra row to learn whether a next page exists — far cheaper
    // than a COUNT(*) on every page for large tables.
    const probe = limit + 1;
    const sql =
      `SELECT * FROM ${target}${whereSql}${orderSql} ` +
      `LIMIT ${probe} OFFSET ${offset}`;

    const hasFilters = !!params.filters && params.filters.length > 0;
    const [data, count, pk] = await Promise.all([
      this.runSql(sql, where.params),
      this.countRows({
        table: params.table,
        schema: params.schema,
        whereSql,
        whereParams: where.params,
        hasFilters,
      }).catch(() => ({ total: null, estimated: false })),
      this.primaryKeyColumns(params.table, params.schema),
    ]);

    const hasMore = data.rows.length > limit;
    const rows = hasMore ? data.rows.slice(0, limit) : data.rows;

    return {
      ...data,
      rows,
      rowCount: rows.length,
      total: count.total,
      estimated: count.estimated,
      hasMore,
      primaryKey: pk,
    };
  }

  /**
   * Row total for the browse footer. The default runs an exact `COUNT(*)`,
   * which is fine for local engines (SQLite). Server engines override this to
   * use cheap catalog estimates and to skip counting filtered views entirely.
   */
  protected async countRows(args: {
    table: string;
    schema?: string;
    whereSql: string;
    whereParams: unknown[];
    hasFilters: boolean;
  }): Promise<{ total: number | null; estimated: boolean }> {
    const target = this.qualify(args.table, args.schema);
    const res = await this.runSql(
      `SELECT COUNT(*) AS count FROM ${target}${args.whereSql}`,
      args.whereParams,
    );
    const total = res.rows[0] ? Number(res.rows[0].count) : null;
    return { total: Number.isFinite(total) ? total : null, estimated: false };
  }

  async query(statement: string, params?: unknown[]): Promise<QueryResult> {
    const result = await this.runSql(statement, params ?? []);
    if (result.rows.length > this.maxRows) {
      return {
        ...result,
        rows: result.rows.slice(0, this.maxRows),
        rowCount: this.maxRows,
        truncated: true,
      };
    }
    return result;
  }

  async insertRow(p: InsertRowParams): Promise<QueryResult> {
    const cols = Object.keys(p.values);
    if (cols.length === 0) {
      throw new BadRequestError('Cannot insert a row with no values');
    }
    const target = this.qualify(p.table, p.schema);
    const placeholders = cols.map((_, i) => this.placeholder(i + 1));
    const sql =
      `INSERT INTO ${target} (${cols.map((c) => this.quoteIdent(c)).join(', ')}) ` +
      `VALUES (${placeholders.join(', ')})`;
    return this.runSql(
      sql,
      cols.map((c) => p.values[c]),
    );
  }

  async updateRow(p: UpdateRowParams): Promise<QueryResult> {
    const changeCols = Object.keys(p.changes);
    const idCols = Object.keys(p.identity);
    if (changeCols.length === 0) {
      throw new BadRequestError('No changes provided');
    }
    if (idCols.length === 0) {
      throw new BadRequestError(
        'Cannot update a row without a primary key identity',
      );
    }
    const target = this.qualify(p.table, p.schema);
    const params: unknown[] = [];
    let idx = 1;

    const setSql = changeCols
      .map((c) => {
        params.push(p.changes[c]);
        return `${this.quoteIdent(c)} = ${this.placeholder(idx++)}`;
      })
      .join(', ');

    const whereSql = idCols
      .map((c) => {
        params.push(p.identity[c]);
        return `${this.quoteIdent(c)} = ${this.placeholder(idx++)}`;
      })
      .join(' AND ');

    return this.runSql(
      `UPDATE ${target} SET ${setSql} WHERE ${whereSql}`,
      params,
    );
  }

  async deleteRow(p: DeleteRowParams): Promise<QueryResult> {
    const idCols = Object.keys(p.identity);
    if (idCols.length === 0) {
      throw new BadRequestError(
        'Cannot delete a row without a primary key identity',
      );
    }
    const target = this.qualify(p.table, p.schema);
    const params: unknown[] = [];
    const whereSql = idCols
      .map((c, i) => {
        params.push(p.identity[c]);
        return `${this.quoteIdent(c)} = ${this.placeholder(i + 1)}`;
      })
      .join(' AND ');

    return this.runSql(`DELETE FROM ${target} WHERE ${whereSql}`, params);
  }

  /* ----- schema management (DDL) ----- */

  /** Auto-increment keyword appended after the type (MySQL → AUTO_INCREMENT). */
  protected autoIncrementKeyword(): string | null {
    return null;
  }

  /** Serial pseudo-type that replaces the column type (Postgres → SERIAL). */
  protected serialType(): string | null {
    return null;
  }

  /** Validate a raw column type string (it cannot be a bound parameter). */
  protected validateType(type: string): string {
    const t = type.trim();
    if (!/^[A-Za-z0-9_ (),]+$/.test(t)) {
      throw new BadRequestError(`Invalid column type: "${type}"`);
    }
    return t;
  }

  protected columnSql(col: ColumnDefinition): string {
    const name = this.quoteIdent(assertSafeIdentifier(col.name));
    let typeSql = this.validateType(col.type);
    if (col.autoIncrement && this.serialType()) typeSql = this.serialType()!;
    let sql = `${name} ${typeSql}`;
    if (col.autoIncrement && this.autoIncrementKeyword()) {
      sql += ` ${this.autoIncrementKeyword()}`;
    }
    if (!col.nullable) sql += ' NOT NULL';
    if (col.unique && !col.primaryKey) sql += ' UNIQUE';
    if (col.defaultValue && col.defaultValue.trim()) {
      sql += ` DEFAULT ${col.defaultValue.trim()}`;
    }
    return sql;
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    if (!spec.columns.length) {
      throw new BadRequestError('A table needs at least one column');
    }
    const target = this.qualify(
      assertSafeIdentifier(spec.table),
      spec.schema ? assertSafeIdentifier(spec.schema) : undefined,
    );
    const parts = spec.columns.map((c) => this.columnSql(c));
    const pk = spec.columns
      .filter((c) => c.primaryKey)
      .map((c) => this.quoteIdent(c.name));
    if (pk.length) parts.push(`PRIMARY KEY (${pk.join(', ')})`);
    await this.runSql(`CREATE TABLE ${target} (${parts.join(', ')})`, []);
  }

  async dropTable(table: string, schema?: string): Promise<void> {
    await this.runSql(`DROP TABLE ${this.qualify(table, schema)}`, []);
  }

  async truncateTable(table: string, schema?: string): Promise<void> {
    await this.runSql(`TRUNCATE TABLE ${this.qualify(table, schema)}`, []);
  }

  async createDatabase(name: string): Promise<void> {
    await this.runSql(
      `CREATE DATABASE ${this.quoteIdent(assertSafeIdentifier(name))}`,
      [],
    );
  }

  async dropDatabase(name: string): Promise<void> {
    await this.runSql(
      `DROP DATABASE ${this.quoteIdent(assertSafeIdentifier(name))}`,
      [],
    );
  }

  /* ----- backup & restore ----- */

  /** Boolean literal for SQL dumps (Postgres → TRUE/FALSE, others → 1/0). */
  protected booleanLiteral(value: boolean): string {
    return value ? '1' : '0';
  }

  private async targetTables(opts: BackupOptions): Promise<TableSchema[]> {
    const schema = await this.getSchema();
    let tables = schema.namespaces.flatMap((ns) => ns.tables);
    tables = tables.filter((t) => t.kind === 'table');
    if (opts.schema)
      tables = tables.filter((t) => (t.schema ?? '') === opts.schema);
    if (opts.tables?.length) {
      const wanted = new Set(opts.tables);
      tables = tables.filter((t) => wanted.has(t.name));
    }
    return tables;
  }

  async backup(opts: BackupOptions): Promise<string> {
    const { database } = await this.getSchema();
    const tables = await this.targetTables(opts);

    if (opts.format === 'json') {
      const doc: BackupDocument = {
        relay: 'backup',
        version: 1,
        engine: this.engine,
        database,
        createdAt: new Date().toISOString(),
        tables: [],
      };
      for (const t of tables) {
        const res = await this.runSql(
          `SELECT * FROM ${this.qualify(t.name, t.schema)}`,
          [],
        );
        doc.tables.push({
          name: t.name,
          schema: t.schema,
          primaryKey: t.primaryKey,
          columns: t.columns.map((c) => c.name),
          rows: res.rows,
        });
      }
      return JSON.stringify(doc, null, 2);
    }

    // SQL dump: DDL + INSERT statements.
    const out: string[] = [
      `-- Relay SQL backup`,
      `-- engine: ${this.engine}`,
      `-- database: ${database}`,
      ``,
    ];
    for (const t of tables) {
      out.push(this.createTableDump(t), ``);
      const res = await this.runSql(
        `SELECT * FROM ${this.qualify(t.name, t.schema)}`,
        [],
      );
      if (res.rows.length === 0) continue;
      const cols = t.columns.map((c) => c.name);
      const colSql = cols.map((c) => this.quoteIdent(c)).join(', ');
      const target = this.qualify(t.name, t.schema);
      for (const row of res.rows) {
        const values = cols.map((c) => this.sqlLiteral(row[c])).join(', ');
        out.push(`INSERT INTO ${target} (${colSql}) VALUES (${values});`);
      }
      out.push(``);
    }
    return out.join('\n');
  }

  private createTableDump(t: TableSchema): string {
    const defs = t.columns.map((c) => {
      let s = `  ${this.quoteIdent(c.name)} ${c.dataType}`;
      if (!c.nullable) s += ' NOT NULL';
      // Skip sequence-backed defaults — they aren't portable in a logical dump.
      if (c.defaultValue && !/nextval|auto_increment/i.test(c.defaultValue)) {
        s += ` DEFAULT ${c.defaultValue}`;
      }
      return s;
    });
    if (t.primaryKey.length) {
      defs.push(
        `  PRIMARY KEY (${t.primaryKey.map((c) => this.quoteIdent(c)).join(', ')})`,
      );
    }
    return `CREATE TABLE IF NOT EXISTS ${this.qualify(t.name, t.schema)} (\n${defs.join(',\n')}\n);`;
  }

  private sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return this.booleanLiteral(value);
    if (value instanceof Date) return `'${value.toISOString()}'`;
    const text =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `'${text.replace(/'/g, "''")}'`;
  }

  async restore(content: string, format: BackupFormat): Promise<RestoreResult> {
    if (format === 'sql') {
      const statements = splitSqlStatements(content);
      let count = 0;
      for (const stmt of statements) {
        await this.runSql(stmt, []);
        count++;
      }
      return { tables: 0, rows: count };
    }

    let doc: BackupDocument;
    try {
      doc = JSON.parse(content) as BackupDocument;
    } catch {
      throw new BadRequestError('Backup file is not valid JSON');
    }
    if (doc.relay !== 'backup' || !Array.isArray(doc.tables)) {
      throw new BadRequestError('Not a Relay backup file');
    }

    let rows = 0;
    for (const table of doc.tables) {
      // Best-effort recreate; ignore "already exists".
      await this.createTable({
        schema: table.schema,
        table: table.name,
        columns: table.columns.map((name) => ({
          name,
          type: this.defaultRestoreType(),
          nullable: true,
          primaryKey: false,
          autoIncrement: false,
        })),
      }).catch(() => undefined);

      rows += await this.bulkInsert(
        table.name,
        table.schema,
        table.columns,
        table.rows,
      );
    }
    return { tables: doc.tables.length, rows };
  }

  /** Column type used when recreating a table from a column-name-only dump. */
  protected defaultRestoreType(): string {
    return 'TEXT';
  }

  private async bulkInsert(
    table: string,
    schema: string | undefined,
    columns: string[],
    rows: Array<Record<string, unknown>>,
  ): Promise<number> {
    if (rows.length === 0 || columns.length === 0) return 0;
    const target = this.qualify(table, schema);
    const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
    let inserted = 0;

    for (let i = 0; i < rows.length; i += RESTORE_BATCH) {
      const batch = rows.slice(i, i + RESTORE_BATCH);
      const params: unknown[] = [];
      let ph = 1;
      const tuples = batch.map((row) => {
        const placeholders = columns.map((c) => {
          params.push(normalizeForInsert(row[c]));
          return this.placeholder(ph++);
        });
        return `(${placeholders.join(', ')})`;
      });
      await this.runSql(
        `INSERT INTO ${target} (${colSql}) VALUES ${tuples.join(', ')}`,
        params,
      );
      inserted += batch.length;
    }
    return inserted;
  }

  /**
   * Primary-key columns for a relation, used to build safe row identities.
   * Default implementation derives them from the schema introspection; engines
   * may override for efficiency.
   */
  protected async primaryKeyColumns(
    table: string,
    schema?: string,
  ): Promise<string[]> {
    const dbSchema = await this.getSchema();
    for (const ns of dbSchema.namespaces) {
      if (schema && ns.name !== schema) continue;
      const found = ns.tables.find((t) => t.name === table);
      if (found) return found.primaryKey;
    }
    return [];
  }
}

/** Coerce a JSON-decoded value into something a driver can bind for INSERT. */
function normalizeForInsert(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Split a `.sql` script into individual statements, respecting single-quoted
 * strings (with `''` escapes) and `--` / block comments. Good enough for
 * Relay-generated dumps and typical hand-written scripts.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inSingle) {
      cur += ch;
      if (ch === "'") {
        if (next === "'") {
          cur += next;
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
