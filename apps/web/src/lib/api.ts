/**
 * Typed client for the Relay NestJS API. Unwraps the `{ data }` envelope and
 * throws a structured {@link ApiError} on `{ error }` responses.
 */
import type {
  BrowseParams,
  BrowseResult,
  ConnectionConfig,
  ConnectionInputDTO,
  CreateTableSpec,
  DatabaseSchema,
  DeleteRowParams,
  CdcReadiness,
  CdcReadinessDTO,
  DriverInfo,
  Hook,
  HookDelivery,
  HookInputDTO,
  HookPreview,
  HookPreviewDTO,
  HookRun,
  InsertRowParams,
  QueryResult,
  UpdateRowParams,
} from '@relay/core';

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      `Cannot reach the Relay API at ${BASE_URL}. Is it running?`,
      'NETWORK',
      0,
      (err as Error).message,
    );
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body?.error ?? {};
    throw new ApiError(
      error.message ?? `Request failed (${res.status})`,
      error.code ?? 'UNKNOWN',
      res.status,
      error.details,
    );
  }
  return body.data as T;
}

function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

export const api = {
  listDrivers: () => request<DriverInfo[]>('/drivers'),

  listConnections: () => request<ConnectionConfig[]>('/connections'),
  getConnection: (id: string) =>
    request<ConnectionConfig>(`/connections/${id}`),
  createConnection: (input: ConnectionInputDTO) =>
    request<ConnectionConfig>('/connections', {
      method: 'POST',
      ...jsonBody(input),
    }),
  updateConnection: (id: string, input: ConnectionInputDTO) =>
    request<ConnectionConfig>(`/connections/${id}`, {
      method: 'PUT',
      ...jsonBody(input),
    }),
  deleteConnection: (id: string) =>
    request<{ id: string }>(`/connections/${id}`, { method: 'DELETE' }),
  testConnection: (input: ConnectionInputDTO) =>
    request<{ success: true }>('/connections/test', {
      method: 'POST',
      ...jsonBody(input),
    }),
  testSavedConnection: (id: string) =>
    request<{ success: true }>(`/connections/${id}/test`, { method: 'POST' }),

  listDatabases: (id: string) =>
    request<string[]>(`/connections/${id}/databases`),
  getSchema: (id: string, database?: string) =>
    request<DatabaseSchema>(`/connections/${id}/schema${dbQuery(database)}`),
  browse: (id: string, params: BrowseParams, database?: string) =>
    request<BrowseResult>(`/connections/${id}/browse${dbQuery(database)}`, {
      method: 'POST',
      ...jsonBody(params),
    }),
  runQuery: (
    id: string,
    statement: string,
    params?: unknown[],
    database?: string,
  ) =>
    request<QueryResult>(`/connections/${id}/query${dbQuery(database)}`, {
      method: 'POST',
      ...jsonBody({ statement, params }),
    }),
  insertRow: (id: string, params: InsertRowParams, database?: string) =>
    request<QueryResult>(`/connections/${id}/rows${dbQuery(database)}`, {
      method: 'POST',
      ...jsonBody(params),
    }),
  updateRow: (id: string, params: UpdateRowParams, database?: string) =>
    request<QueryResult>(`/connections/${id}/rows${dbQuery(database)}`, {
      method: 'PATCH',
      ...jsonBody(params),
    }),
  deleteRow: (id: string, params: DeleteRowParams, database?: string) =>
    request<QueryResult>(`/connections/${id}/rows${dbQuery(database)}`, {
      method: 'DELETE',
      ...jsonBody(params),
    }),

  createDatabase: (id: string, name: string) =>
    request<{ success: true }>(`/connections/${id}/ddl/database`, {
      method: 'POST',
      ...jsonBody({ name }),
    }),
  dropDatabase: (id: string, name: string) =>
    request<{ success: true }>(`/connections/${id}/ddl/drop-database`, {
      method: 'POST',
      ...jsonBody({ name }),
    }),
  createTable: (id: string, spec: CreateTableSpec, database?: string) =>
    request<{ success: true }>(
      `/connections/${id}/ddl/table${dbQuery(database)}`,
      { method: 'POST', ...jsonBody(spec) },
    ),
  dropTable: (
    id: string,
    table: string,
    schema?: string,
    database?: string,
  ) =>
    request<{ success: true }>(
      `/connections/${id}/ddl/drop-table${dbQuery(database)}`,
      { method: 'POST', ...jsonBody({ table, schema }) },
    ),
  truncateTable: (
    id: string,
    table: string,
    schema?: string,
    database?: string,
  ) =>
    request<{ success: true }>(
      `/connections/${id}/ddl/truncate-table${dbQuery(database)}`,
      { method: 'POST', ...jsonBody({ table, schema }) },
    ),

  backup: (
    id: string,
    opts: { format: 'json' | 'sql'; tables?: string[]; schema?: string },
    database?: string,
  ) =>
    request<{ filename: string; format: string; content: string }>(
      `/connections/${id}/backup${dbQuery(database)}`,
      { method: 'POST', ...jsonBody(opts) },
    ),
  restore: (
    id: string,
    body: { format: 'json' | 'sql'; content: string },
    database?: string,
  ) =>
    request<{ tables: number; rows: number }>(
      `/connections/${id}/restore${dbQuery(database)}`,
      { method: 'POST', ...jsonBody(body) },
    ),

  /* ----- automation hooks ----- */

  listHooks: () => request<Hook[]>('/hooks'),
  getHook: (id: string) => request<Hook>(`/hooks/${id}`),
  createHook: (input: HookInputDTO) =>
    request<Hook>('/hooks', { method: 'POST', ...jsonBody(input) }),
  updateHook: (id: string, input: HookInputDTO) =>
    request<Hook>(`/hooks/${id}`, { method: 'PUT', ...jsonBody(input) }),
  deleteHook: (id: string) =>
    request<{ id: string }>(`/hooks/${id}`, { method: 'DELETE' }),
  previewHook: (id: string, body: HookPreviewDTO) =>
    request<HookPreview>(`/hooks/${id}/preview`, {
      method: 'POST',
      ...jsonBody(body),
    }),
  startHookRun: (
    id: string,
    opts: { resumeRunId?: string; runId?: string; retryFailedOf?: string } = {},
  ) =>
    request<HookRun>(`/hooks/${id}/runs`, {
      method: 'POST',
      ...jsonBody(opts),
    }),
  listHookRuns: (id: string) => request<HookRun[]>(`/hooks/${id}/runs`),
  getHookRun: (id: string, runId: string) =>
    request<HookRun>(`/hooks/${id}/runs/${runId}`),
  cancelHookRun: (id: string, runId: string) =>
    request<HookRun>(`/hooks/${id}/runs/${runId}/cancel`, { method: 'POST' }),
  listHookDeliveries: (
    id: string,
    runId: string,
    opts: {
      status?: 'success' | 'failed' | 'skipped';
      from?: number;
      to?: number;
      offset?: number;
      limit?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.from != null) q.set('from', String(opts.from));
    if (opts.to != null) q.set('to', String(opts.to));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    if (opts.limit != null) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return request<HookDelivery[]>(
      `/hooks/${id}/runs/${runId}/deliveries${qs ? `?${qs}` : ''}`,
    );
  },
  skipHookRun: (id: string, runId: string, sequences: number[]) =>
    request<{ skipped: number }>(`/hooks/${id}/runs/${runId}/skip`, {
      method: 'POST',
      ...jsonBody({ sequences }),
    }),
  startWatch: (id: string) =>
    request<HookRun>(`/hooks/${id}/watch/start`, { method: 'POST' }),
  stopWatch: (id: string) =>
    request<HookRun | null>(`/hooks/${id}/watch/stop`, { method: 'POST' }),
  cdcReadiness: (body: CdcReadinessDTO) =>
    request<CdcReadiness>('/hooks/cdc/readiness', { method: 'POST', ...jsonBody(body) }),
  retryFailedDeliveries: (id: string, runId: string) =>
    request<HookRun>(`/hooks/${id}/runs/${runId}/retry-failed`, { method: 'POST' }),
};

function dbQuery(database?: string): string {
  return database ? `?database=${encodeURIComponent(database)}` : '';
}
