/**
 * MongoDB adapter. collections map to "tables", documents map to rows. schema
 * is inferred by sampling documents (Mongo is schemaless). the query editor
 * speaks a small JSON dialect, see {@link MongodbAdapter.query}
 */
import { MongoClient, ObjectId, type Db } from 'mongodb';
import type {
  AdapterCapabilities,
  BackupDocument,
  BackupFormat,
  BackupOptions,
  BrowseParams,
  BrowseResult,
  ColumnSchema,
  ConnectionConfig,
  CreateTableSpec,
  DatabaseAdapter,
  DatabaseSchema,
  DeleteRowParams,
  FilterSpec,
  InsertRowParams,
  QueryResult,
  RestoreResult,
  TableSchema,
  UpdateRowParams,
  UpsertRowParams,
} from '../types';
import {
  BadRequestError,
  ConnectionError,
  QueryError,
  UnsupportedError,
} from '../../errors';

export const MONGODB_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'mongo',
  schemas: false,
  multipleDatabases: true,
  foreignKeys: false,
  rowEditing: true,
  transactions: false,
  // collections behave like tables (create/drop/empty); databases get created
  // implicitly when you add a collection, so we don't expose explicit DB creation
  ddl: true,
  manageDatabases: false,
  backupFormats: ['json'],
};

const SAMPLE_SIZE = 50;
const DEFAULT_LIMIT = 100;

export class MongodbAdapter implements DatabaseAdapter {
  readonly engine = 'mongodb' as const;
  readonly capabilities = MONGODB_CAPABILITIES;

  private readonly config: ConnectionConfig;
  private client: MongoClient | null = null;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  private uri(): string {
    if (this.config.connectionString) return this.config.connectionString;
    const auth =
      this.config.user && this.config.password
        ? `${encodeURIComponent(this.config.user)}:${encodeURIComponent(
            this.config.password,
          )}@`
        : '';
    const host = this.config.host ?? 'localhost';
    const port = this.config.port ?? 27017;
    return `mongodb://${auth}${host}:${port}`;
  }

  private async getClient(): Promise<MongoClient> {
    if (this.client) return this.client;
    try {
      this.client = new MongoClient(this.uri(), {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 5,
      });
      await this.client.connect();
      return this.client;
    } catch (err) {
      this.client = null;
      throw new ConnectionError(
        `Could not connect to MongoDB: ${(err as Error).message}`,
      );
    }
  }

  private async getDb(name?: string): Promise<Db> {
    const client = await this.getClient();
    const dbName = name ?? this.config.database ?? 'test';
    return client.db(dbName);
  }

  async connect(): Promise<void> {
    await this.getClient();
  }

  async ping(): Promise<void> {
    const db = await this.getDb();
    await db.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.getClient();
    const res = await client.db().admin().listDatabases();
    return res.databases.map((d) => d.name);
  }

  async getSchema(database?: string): Promise<DatabaseSchema> {
    const db = await this.getDb(database);
    const collections = await db.listCollections().toArray();
    const tables: TableSchema[] = [];

    for (const coll of collections) {
      const sample = await db
        .collection(coll.name)
        .find({}, { limit: SAMPLE_SIZE })
        .toArray();
      const fields = inferColumns(sample);
      const estimated = await db
        .collection(coll.name)
        .estimatedDocumentCount()
        .catch(() => null);
      tables.push({
        name: coll.name,
        kind: 'collection',
        columns: fields,
        indexes: [],
        foreignKeys: [],
        primaryKey: ['_id'],
        estimatedRows: estimated,
        comment: null,
      });
    }

    return {
      database: db.databaseName,
      namespaces: [{ name: '', tables }],
    };
  }

  async browse(params: BrowseParams): Promise<BrowseResult> {
    const db = await this.getDb(params.schema);
    const coll = db.collection(params.table);
    const limit = Math.min(Math.max(params.limit, 1), 1000);
    const filter = buildMongoFilter(params.filters);
    const sort: Record<string, 1 | -1> = {};
    for (const s of params.sort ?? []) {
      sort[s.column] = s.direction === 'desc' ? -1 : 1;
    }

    const hasFilters = Object.keys(filter).length > 0;
    const started = performance.now();
    // probe one extra doc to detect a next page without a full count
    const cursor = coll.find(filter).skip(params.offset).limit(limit + 1);
    if (Object.keys(sort).length > 0) cursor.sort(sort);
    const probed = await cursor.toArray();
    const hasMore = probed.length > limit;
    const docs = hasMore ? probed.slice(0, limit) : probed;

    // estimatedDocumentCount is O(1) on the collection metadata; we only fall
    // back to the exact countDocuments when a filter is applied
    const total = hasFilters
      ? await coll.countDocuments(filter).catch(() => null)
      : await coll.estimatedDocumentCount().catch(() => null);

    const rows = docs.map(normalizeDoc);
    return {
      columns: inferColumns(docs).map((c) => ({ name: c.name })),
      rows,
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      command: 'find',
      total,
      estimated: !hasFilters,
      hasMore,
      primaryKey: ['_id'],
    };
  }

  /**
   * runs a JSON command document:
   *   { "collection": "users", "find": { "active": true },
   *     "sort": { "createdAt": -1 }, "limit": 20 }
   *   { "collection": "orders", "aggregate": [ { "$group": ... } ] }
   *   { "collection": "users", "countDocuments": { } }
   */
  async query(statement: string): Promise<QueryResult> {
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(statement);
    } catch {
      throw new BadRequestError(
        'MongoDB query must be a JSON command document, e.g. ' +
          '{ "collection": "users", "find": {} }',
      );
    }
    const collName = spec.collection;
    if (typeof collName !== 'string') {
      throw new BadRequestError('Query document requires a "collection" field');
    }
    const db = await this.getDb();
    const coll = db.collection(collName);
    const started = performance.now();

    try {
      if (spec.aggregate) {
        const pipeline = spec.aggregate as Record<string, unknown>[];
        const docs = await coll.aggregate(pipeline).limit(1000).toArray();
        return finalize(docs, started, 'aggregate');
      }
      if ('countDocuments' in spec) {
        const count = await coll.countDocuments(
          (spec.countDocuments as Record<string, unknown>) ?? {},
        );
        return {
          columns: [{ name: 'count' }],
          rows: [{ count }],
          rowCount: 1,
          executionMs: Math.round(performance.now() - started),
          command: 'countDocuments',
        };
      }
      const filter = (spec.find as Record<string, unknown>) ?? {};
      const cursor = coll
        .find(filter)
        .limit(Number(spec.limit ?? DEFAULT_LIMIT));
      if (spec.sort) cursor.sort(spec.sort as Record<string, 1 | -1>);
      const docs = await cursor.toArray();
      return finalize(docs, started, 'find');
    } catch (err) {
      throw new QueryError((err as Error).message);
    }
  }

  async insertRow(p: InsertRowParams): Promise<QueryResult> {
    const db = await this.getDb(p.schema);
    const res = await db.collection(p.table).insertOne(p.values);
    return writeResult(res.acknowledged ? 1 : 0, 'insertOne');
  }

  async updateRow(p: UpdateRowParams): Promise<QueryResult> {
    const db = await this.getDb(p.schema);
    const res = await db
      .collection(p.table)
      .updateOne(coerceId(p.identity), { $set: p.changes });
    return writeResult(res.modifiedCount, 'updateOne');
  }

  async deleteRow(p: DeleteRowParams): Promise<QueryResult> {
    const db = await this.getDb(p.schema);
    const res = await db.collection(p.table).deleteOne(coerceId(p.identity));
    return writeResult(res.deletedCount, 'deleteOne');
  }

  async upsertRow(p: UpsertRowParams): Promise<QueryResult> {
    if (p.keyColumns.length === 0) {
      throw new QueryError('Cannot upsert without key columns to match on');
    }
    const db = await this.getDb(p.schema);
    const filter: Record<string, unknown> = {};
    for (const k of p.keyColumns) filter[k] = p.values[k];
    const res = await db
      .collection(p.table)
      .updateOne(coerceId(filter), { $set: p.values }, { upsert: true });
    return writeResult(res.modifiedCount + (res.upsertedCount ?? 0), 'upsertOne');
  }

  /* ----- schema management ----- */

  async createTable(spec: CreateTableSpec): Promise<void> {
    const db = await this.getDb(spec.schema);
    await db.createCollection(spec.table);
  }

  async dropTable(table: string, schema?: string): Promise<void> {
    const db = await this.getDb(schema);
    await db.collection(table).drop();
  }

  async truncateTable(table: string, schema?: string): Promise<void> {
    const db = await this.getDb(schema);
    await db.collection(table).deleteMany({});
  }

  async createDatabase(): Promise<void> {
    throw new UnsupportedError(
      'MongoDB creates databases automatically when the first collection is added.',
    );
  }

  async dropDatabase(name: string): Promise<void> {
    const client = await this.getClient();
    await client.db(name).dropDatabase();
  }

  /* ----- backup & restore ----- */

  async backup(opts: BackupOptions): Promise<string> {
    if (opts.format !== 'json') {
      throw new UnsupportedError('MongoDB supports JSON backups only.');
    }
    const db = await this.getDb();
    let names = (await db.listCollections().toArray()).map((c) => c.name);
    if (opts.tables?.length) {
      const wanted = new Set(opts.tables);
      names = names.filter((n) => wanted.has(n));
    }

    const doc: BackupDocument = {
      dataBridge: 'backup',
      version: 1,
      engine: this.engine,
      database: db.databaseName,
      createdAt: new Date().toISOString(),
      tables: [],
    };
    for (const name of names) {
      const docs = await db.collection(name).find({}).toArray();
      const rows = docs.map(normalizeDoc);
      doc.tables.push({
        name,
        primaryKey: ['_id'],
        columns: inferColumns(docs).map((c) => c.name),
        rows,
      });
    }
    return JSON.stringify(doc, null, 2);
  }

  async restore(content: string, format: BackupFormat): Promise<RestoreResult> {
    if (format !== 'json') {
      throw new UnsupportedError('MongoDB supports JSON restores only.');
    }
    let doc: BackupDocument;
    try {
      doc = JSON.parse(content) as BackupDocument;
    } catch {
      throw new BadRequestError('Backup file is not valid JSON');
    }
    if (doc.dataBridge !== 'backup' || !Array.isArray(doc.tables)) {
      throw new BadRequestError('Not a Data Bridge backup file');
    }
    const db = await this.getDb();
    let rows = 0;
    for (const table of doc.tables) {
      await db.createCollection(table.name).catch(() => undefined);
      if (table.rows.length > 0) {
        const docs = table.rows.map((r) => coerceId({ ...r }));
        await db
          .collection(table.name)
          .insertMany(docs, { ordered: false })
          .catch(() => undefined);
        rows += table.rows.length;
      }
    }
    return { tables: doc.tables.length, rows };
  }
}

/* ----- helpers ----- */

function coerceId(identity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...identity };
  if (typeof out._id === 'string' && ObjectId.isValid(out._id)) {
    out._id = new ObjectId(out._id);
  }
  return out;
}

function normalizeDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = v instanceof ObjectId ? v.toHexString() : v;
  }
  return out;
}

function inferColumns(docs: Record<string, unknown>[]): ColumnSchema[] {
  const seen = new Map<string, string>();
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc)) {
      if (!seen.has(k)) seen.set(k, jsType(v));
    }
  }
  return [...seen.entries()].map(([name, dataType]) => ({
    name,
    dataType,
    nullable: true,
    isPrimaryKey: name === '_id',
    isUnique: name === '_id',
    isAutoIncrement: false,
    defaultValue: null,
    comment: null,
    references: null,
  }));
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof ObjectId) return 'objectId';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  return typeof v;
}

function buildMongoFilter(
  filters: FilterSpec[] | undefined,
): Record<string, unknown> {
  if (!filters || filters.length === 0) return {};
  const query: Record<string, unknown> = {};
  for (const f of filters) {
    switch (f.operator) {
      case 'eq':
        query[f.column] = f.value;
        break;
      case 'neq':
        query[f.column] = { $ne: f.value };
        break;
      case 'lt':
        query[f.column] = { $lt: f.value };
        break;
      case 'lte':
        query[f.column] = { $lte: f.value };
        break;
      case 'gt':
        query[f.column] = { $gt: f.value };
        break;
      case 'gte':
        query[f.column] = { $gte: f.value };
        break;
      case 'contains':
        query[f.column] = { $regex: String(f.value ?? ''), $options: 'i' };
        break;
      case 'startsWith':
        query[f.column] = { $regex: `^${String(f.value ?? '')}`, $options: 'i' };
        break;
      case 'endsWith':
        query[f.column] = { $regex: `${String(f.value ?? '')}$`, $options: 'i' };
        break;
      case 'isNull':
        query[f.column] = null;
        break;
      case 'notNull':
        query[f.column] = { $ne: null };
        break;
    }
  }
  return query;
}

function finalize(
  docs: Record<string, unknown>[],
  started: number,
  command: string,
): QueryResult {
  const rows = docs.map(normalizeDoc);
  return {
    columns: inferColumns(docs).map((c) => ({ name: c.name })),
    rows,
    rowCount: rows.length,
    executionMs: Math.round(performance.now() - started),
    command,
  };
}

function writeResult(affected: number, command: string): QueryResult {
  return {
    columns: [],
    rows: [],
    rowCount: affected,
    affectedRows: affected,
    executionMs: 0,
    command,
  };
}
