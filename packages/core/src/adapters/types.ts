/**
 * Core adapter contract.
 *
 * Every database engine Relay supports — relational, document, key-value, or
 * anything added later — implements {@link DatabaseAdapter}. The rest of the
 * application (API routes, UI) depends ONLY on these types, never on a concrete
 * driver. Adding a new engine therefore means: implement this interface and
 * register it. Nothing else changes.
 *
 * This module is intentionally framework-agnostic: no Next.js, React, or Node
 * server imports. It is pure domain logic and is unit-testable in isolation.
 */

export type DatabaseEngine =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mongodb'
  | 'redis'
  | 'mssql';

/** The query dialect an engine exposes to the editor surface. */
export type QueryLanguage = 'sql' | 'mongo' | 'redis' | 'none';

/**
 * Declarative description of what an engine can do. The UI reads these to
 * enable/disable features (e.g. hide the ER diagram tab for Redis) instead of
 * branching on the engine name everywhere.
 */
export interface AdapterCapabilities {
  /** Supports arbitrary user-authored queries in the editor. */
  query: boolean;
  /** The language the query editor should use. */
  queryLanguage: QueryLanguage;
  /** Has a schema/namespace layer above tables (e.g. Postgres schemas). */
  schemas: boolean;
  /** Supports multiple databases/catalogs on one connection. */
  multipleDatabases: boolean;
  /** Exposes foreign-key relationships (drives the ER diagram). */
  foreignKeys: boolean;
  /** Supports row-level insert/update/delete through the data grid. */
  rowEditing: boolean;
  /** Whether transactions are available for batched mutations. */
  transactions: boolean;
  /** Supports creating / dropping / truncating tables (or collections). */
  ddl: boolean;
  /** Supports creating / dropping databases on this connection. */
  manageDatabases: boolean;
  /** Backup/restore formats this engine can produce/consume. */
  backupFormats: BackupFormat[];
}

/* -------------------------------------------------------------------------- */
/* Connection configuration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A saved connection. Engine-specific validation happens in each adapter; the
 * shared shape keeps the store and UI uniform. `password` is only ever present
 * in decrypted form inside the server process — it is encrypted at rest.
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  engine: DatabaseEngine;
  /** Optional accent color for the UI (hex). */
  color?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Database name, or file path for SQLite. */
  database?: string;
  /** Use TLS. Engine adapters interpret the specifics. */
  ssl?: boolean;
  /** Full connection URI; when present, takes precedence over discrete fields. */
  connectionString?: string;
  /** Free-form engine-specific options (e.g. Mongo authSource, Redis db index). */
  options?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A connection without the assigned id / timestamps (creation payload). */
export type ConnectionInput = Omit<
  ConnectionConfig,
  'id' | 'createdAt' | 'updatedAt'
>;

/* -------------------------------------------------------------------------- */
/* Schema introspection                                                       */
/* -------------------------------------------------------------------------- */

export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  defaultValue: string | null;
  comment: string | null;
  /** Outbound foreign-key target, if this column references another table. */
  references: {
    schema?: string;
    table: string;
    column: string;
  } | null;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeySchema {
  name: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
}

export type RelationKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'collection'
  | 'keyspace';

export interface TableSchema {
  name: string;
  schema?: string;
  kind: RelationKind;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  primaryKey: string[];
  estimatedRows: number | null;
  comment: string | null;
}

export interface SchemaNamespace {
  /** Schema/namespace name. Empty string for engines without a schema layer. */
  name: string;
  tables: TableSchema[];
}

export interface DatabaseSchema {
  database: string;
  namespaces: SchemaNamespace[];
}

/* -------------------------------------------------------------------------- */
/* Query + browse                                                             */
/* -------------------------------------------------------------------------- */

export interface QueryColumn {
  name: string;
  dataType?: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
  /** Rows returned for reads; affected rows for writes. */
  rowCount: number;
  affectedRows?: number;
  executionMs: number;
  /** True when the result was capped by the configured row limit. */
  truncated?: boolean;
  /** Statement kind / operation name, e.g. "SELECT" or "find". */
  command?: string;
  /** Informational message from the engine (notices, warnings). */
  notice?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'notNull'
  | 'in';

export interface FilterSpec {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface BrowseParams {
  schema?: string;
  table: string;
  limit: number;
  offset: number;
  sort?: SortSpec[];
  filters?: FilterSpec[];
}

export interface BrowseResult extends QueryResult {
  /** Total rows matching the filter, or null when too expensive to compute. */
  total: number | null;
  /** True when `total` is an approximate catalog estimate, not an exact count. */
  estimated?: boolean;
  /** True when more rows exist beyond this page (from a `limit + 1` probe). */
  hasMore: boolean;
  primaryKey: string[];
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

/** Column → value map identifying a single row (its primary key). */
export type RowIdentity = Record<string, unknown>;

export interface InsertRowParams {
  schema?: string;
  table: string;
  values: Record<string, unknown>;
}

export interface UpdateRowParams {
  schema?: string;
  table: string;
  identity: RowIdentity;
  changes: Record<string, unknown>;
}

export interface DeleteRowParams {
  schema?: string;
  table: string;
  identity: RowIdentity;
}

/* -------------------------------------------------------------------------- */
/* Schema management (DDL)                                                     */
/* -------------------------------------------------------------------------- */

export interface ColumnDefinition {
  name: string;
  /** Raw column type for the engine, e.g. "varchar(255)", "int", "text". */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique?: boolean;
  /** Raw default expression, e.g. "0", "now()", "'pending'". */
  defaultValue?: string;
}

export interface CreateTableSpec {
  schema?: string;
  table: string;
  columns: ColumnDefinition[];
}

/* -------------------------------------------------------------------------- */
/* Backup & restore                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `json` — portable, engine-agnostic dump (schema + data) that any engine can
 * read back, with parameterized inserts on restore.
 * `sql`  — a `.sql` script of DDL + INSERT statements (relational engines only).
 */
export type BackupFormat = 'json' | 'sql';

export interface BackupOptions {
  format: BackupFormat;
  /** Restrict to these relations; defaults to every table in the database. */
  tables?: string[];
  schema?: string;
}

/** The portable JSON backup shape (also embedded inside `json` dumps). */
export interface BackupDocument {
  relay: 'backup';
  version: 1;
  engine: DatabaseEngine;
  database: string;
  createdAt: string;
  tables: Array<{
    name: string;
    schema?: string;
    primaryKey: string[];
    columns: string[];
    rows: Array<Record<string, unknown>>;
  }>;
}

export interface RestoreResult {
  tables: number;
  rows: number;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  readonly capabilities: AdapterCapabilities;

  /** Establish the underlying connection/pool. Idempotent. */
  connect(): Promise<void>;
  /** Lightweight liveness check. */
  ping(): Promise<void>;
  /** Release all resources. */
  close(): Promise<void>;

  /** List databases/catalogs reachable on this connection. */
  listDatabases(): Promise<string[]>;
  /** Introspect the full schema of the active (or given) database. */
  getSchema(database?: string): Promise<DatabaseSchema>;

  /** Paginated, filtered, sorted read of a single relation. */
  browse(params: BrowseParams): Promise<BrowseResult>;
  /** Execute a user-authored statement in the engine's query language. */
  query(statement: string, params?: unknown[]): Promise<QueryResult>;

  insertRow(params: InsertRowParams): Promise<QueryResult>;
  updateRow(params: UpdateRowParams): Promise<QueryResult>;
  deleteRow(params: DeleteRowParams): Promise<QueryResult>;

  /* schema management — guarded by `capabilities.ddl` / `manageDatabases` */
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  createTable(spec: CreateTableSpec): Promise<void>;
  dropTable(table: string, schema?: string): Promise<void>;
  truncateTable(table: string, schema?: string): Promise<void>;

  /* backup & restore — guarded by `capabilities.backupFormats` */
  backup(options: BackupOptions): Promise<string>;
  restore(content: string, format: BackupFormat): Promise<RestoreResult>;
}
