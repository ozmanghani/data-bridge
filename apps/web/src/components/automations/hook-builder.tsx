'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Webhook,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  renderRow,
  type FilterSpec,
  type HookInputDTO,
  type SortSpec,
  type TableSchema,
} from '@relay/core';
import { api, ApiError } from '@/lib/api';
import {
  useBrowse,
  useConnections,
  useCreateHook,
  useDatabases,
  useSchema,
  useUpdateHook,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PAGE_SIZE = 100;

type AuthType = 'none' | 'bearer' | 'header';

interface Destination {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  authType: AuthType;
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  headers: { key: string; value: string }[];
  idempotency: boolean;
}

interface Delivery {
  batchSize: number;
  maxAttempts: number;
  minDelayMs: number;
  timeoutMs: number;
  onError: 'continue' | 'abort';
}

function blankDestination(): Destination {
  return {
    url: '',
    method: 'POST',
    authType: 'none',
    authToken: '',
    authHeaderName: '',
    authHeaderValue: '',
    headers: [],
    idempotency: false,
  };
}

function blankDelivery(): Delivery {
  return {
    batchSize: 1,
    maxAttempts: 3,
    minDelayMs: 0,
    timeoutMs: 15000,
    onError: 'continue',
  };
}

function jsType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function HookBuilder() {
  const { hookEditor, closeHookEditor, selectHook, openConnectionDialog, automationTab } =
    useStudio();
  const editing = hookEditor.editingId;
  const create = useCreateHook();
  const update = useUpdateHook();

  // ----- source -----
  const [name, setName] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [database, setDatabase] = useState('');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [mode, setMode] = useState<'selected' | 'all'>('all');
  const [selectedKeys, setSelectedKeys] = useState<Map<string, unknown>>(
    new Map(),
  );
  const [included, setIncluded] = useState<Set<string>>(new Set());
  /** Column preference: null = all columns, array = a pinned subset (editing). */
  const [fieldsPref, setFieldsPref] = useState<string[] | null>(null);
  const [offset, setOffset] = useState(0);

  // ----- trigger -----
  // The builder is locked to one of two environments, decided by the sidebar tab
  // (new) or the hook's existing trigger (editing). 'job' = replay-only;
  // 'hook' = listen-only (polling/CDC). They never share trigger UI.
  const [builderKind, setBuilderKind] = useState<'job' | 'hook'>('job');
  const [triggerKind, setTriggerKind] = useState<'replay' | 'watch' | 'cdc'>('replay');
  const [watchStrategy, setWatchStrategy] = useState<
    'increment' | 'timestamp' | 'snapshot'
  >('increment');
  const [watchColumn, setWatchColumn] = useState('');
  const [pollSeconds, setPollSeconds] = useState(5);
  const [watchStartFrom, setWatchStartFrom] = useState<'now' | 'beginning'>('now');
  const [cdcOps, setCdcOps] = useState<Set<'insert' | 'update' | 'delete'>>(
    new Set(['insert', 'update', 'delete']),
  );
  const [readiness, setReadiness] = useState<import('@relay/core').CdcReadiness | null>(null);
  const [checkingCdc, setCheckingCdc] = useState(false);

  // ----- payload / destination / delivery -----
  const [wrapKey, setWrapKey] = useState('');
  const [dest, setDest] = useState<Destination>(blankDestination);
  const [delivery, setDelivery] = useState<Delivery>(blankDelivery);

  const { data: connections } = useConnections();
  const { data: databases } = useDatabases(connectionId || null);
  const { data: schemaData } = useSchema(
    connectionId || null,
    database || undefined,
  );
  const tables = useMemo<TableSchema[]>(
    () => schemaData?.namespaces.flatMap((ns) => ns.tables) ?? [],
    [schemaData],
  );

  const browseParams = useMemo(
    () =>
      table
        ? { schema: schema || undefined, table, limit: PAGE_SIZE, offset }
        : null,
    [table, schema, offset],
  );
  const {
    data: browse,
    isFetching,
    refetch,
  } = useBrowse(connectionId || null, browseParams, database || undefined);

  const columns = useMemo(() => browse?.columns ?? [], [browse]);
  const rows = useMemo(() => browse?.rows ?? [], [browse]);
  const pk = useMemo(() => browse?.primaryKey ?? [], [browse]);
  const singlePk = pk.length === 1 ? pk[0]! : null;

  /* Populate from an existing hook or a seed when opened. */
  useEffect(() => {
    if (!hookEditor.open) return;
    if (editing) {
      api.getHook(editing).then(loadHook, (err) =>
        toast.error('Could not load hook for editing', {
          description: err instanceof ApiError ? err.message : String(err),
        }),
      );
      return;
    }
    reset();
    // New items belong to the active sidebar tab's environment.
    const kind = automationTab === 'hooks' ? 'hook' : 'job';
    setBuilderKind(kind);
    setTriggerKind(kind === 'hook' ? 'watch' : 'replay');
    if (hookEditor.seed) {
      setConnectionId(hookEditor.seed.connectionId);
      setDatabase(hookEditor.seed.database ?? '');
      setSchema(hookEditor.seed.schema ?? '');
      setTable(hookEditor.seed.table);
      setName(`${hookEditor.seed.table} → webhook`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hookEditor.open, editing, hookEditor.seed]);

  /*
   * Whenever a (new) table's columns load, include ALL of them by default.
   * Keyed on the column signature so switching between tables — even ones with
   * the same column count — re-initializes. When editing a hook that pinned a
   * subset, `pendingFields` is applied once instead.
   */
  const colSig = columns.map((c) => c.name).join(' ');
  const appliedKey = useRef('');
  useEffect(() => {
    if (columns.length === 0) return;
    const key = `${colSig}|${fieldsPref ? fieldsPref.join(' ') : '*'}`;
    if (appliedKey.current === key) return;
    appliedKey.current = key;
    const all = columns.map((c) => c.name);
    if (fieldsPref && fieldsPref.length > 0) {
      const allow = new Set(fieldsPref);
      setIncluded(new Set(all.filter((n) => allow.has(n))));
    } else {
      setIncluded(new Set(all));
    }
  }, [colSig, fieldsPref, columns]);

  function reset() {
    setName('');
    setConnectionId('');
    setDatabase('');
    setSchema('');
    setTable('');
    setMode('all');
    setSelectedKeys(new Map());
    setIncluded(new Set());
    setFieldsPref(null);
    setOffset(0);
    setTriggerKind('replay');
    setWatchStrategy('increment');
    setWatchColumn('');
    setPollSeconds(5);
    setWatchStartFrom('now');
    setCdcOps(new Set(['insert', 'update', 'delete']));
    setReadiness(null);
    setWrapKey('');
    setDest(blankDestination());
    setDelivery(blankDelivery());
  }

  function loadHook(h: import('@relay/core').Hook) {
    setName(h.name);
    setConnectionId(h.source.connectionId);
    setDatabase(h.source.database ?? '');
    setMode('all');
    setSelectedKeys(new Map());
    if (h.source.kind === 'table') {
      setSchema(h.source.schema ?? '');
      setTable(h.source.table);
      const inFilter = h.source.filters?.find((f) => f.operator === 'in');
      if (inFilter && Array.isArray(inFilter.value)) {
        setMode('selected');
        setSelectedKeys(
          new Map((inFilter.value as unknown[]).map((v) => [String(v), v])),
        );
      }
    }
    // Applied when the table's columns load (subset = pinned fields; none = all).
    setFieldsPref(h.transform.fields ?? null);
    setWrapKey(h.transform.wrapKey ?? '');
    if (h.trigger.kind === 'watch') {
      setBuilderKind('hook');
      setTriggerKind('watch');
      setWatchStrategy(h.trigger.strategy.strategy);
      setWatchColumn(
        h.trigger.strategy.strategy === 'snapshot' ? '' : h.trigger.strategy.column,
      );
      setPollSeconds(Math.round(h.trigger.pollIntervalMs / 1000));
      setWatchStartFrom(h.trigger.startFrom);
    } else if (h.trigger.kind === 'cdc') {
      setBuilderKind('hook');
      setTriggerKind('cdc');
      setCdcOps(new Set(h.trigger.operations));
    } else {
      setBuilderKind('job');
      setTriggerKind('replay');
    }
    setDest({
      url: h.destination.url,
      method: h.destination.method,
      authType: h.destination.auth.type,
      authToken:
        h.destination.auth.type === 'bearer' ? h.destination.auth.token : '',
      authHeaderName:
        h.destination.auth.type === 'header' ? h.destination.auth.name : '',
      authHeaderValue:
        h.destination.auth.type === 'header' ? h.destination.auth.value : '',
      headers: Object.entries(h.destination.headers ?? {}).map(
        ([key, value]) => ({
          key,
          value,
        }),
      ),
      idempotency: h.destination.idempotency,
    });
    setDelivery({
      batchSize: h.delivery.batchSize,
      maxAttempts: h.delivery.maxAttempts,
      minDelayMs: h.delivery.minDelayMs,
      timeoutMs: h.delivery.timeoutMs,
      onError: h.delivery.onError,
    });
  }

  /* The row used to preview the payload: a selected one if available, else first. */
  const sampleRow = useMemo(() => {
    if (mode === 'selected' && singlePk) {
      const hit = rows.find((r) => selectedKeys.has(String(r[singlePk])));
      if (hit) return hit;
    }
    return rows[0];
  }, [rows, mode, singlePk, selectedKeys]);

  const includedList = useMemo(
    () => columns.map((c) => c.name).filter((n) => included.has(n)),
    [columns, included],
  );

  /* Live payload: schema (field → type) + a real sample body. */
  const preview = useMemo(() => {
    if (!sampleRow || includedList.length === 0) return null;
    const schemaShape: Record<string, string> = {};
    for (const c of includedList) schemaShape[c] = jsType(sampleRow[c]);
    let body: unknown = null;
    let error: string | null = null;
    try {
      body = renderRow(
        sampleRow,
        {
          template: '{{$row}}',
          fields: includedList,
          wrapKey: wrapKey || undefined,
        },
        { table: table || '(table)', now: new Date().toISOString(), index: 0 },
      ).body;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return {
      schema: wrapKey ? { [wrapKey]: schemaShape } : schemaShape,
      body,
      error,
    };
  }, [sampleRow, includedList, wrapKey, table]);

  /* ----- selection helpers ----- */

  function toggleRow(row: Record<string, unknown>) {
    if (!singlePk) return;
    const key = String(row[singlePk]);
    setSelectedKeys((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, row[singlePk]);
      return next;
    });
  }

  function togglePage() {
    if (!singlePk) return;
    setSelectedKeys((prev) => {
      const next = new Map(prev);
      const allOn = rows.every((r) => next.has(String(r[singlePk])));
      for (const r of rows) {
        const key = String(r[singlePk]);
        if (allOn) next.delete(key);
        else next.set(key, r[singlePk]);
      }
      return next;
    });
  }

  function toggleColumn(name: string) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /* ----- save ----- */

  const sendCount =
    mode === 'selected' ? selectedKeys.size : (browse?.total ?? null);
  const watchNeedsColumn =
    triggerKind === 'watch' && watchStrategy !== 'snapshot' && !watchColumn;
  const canSave =
    !!connectionId &&
    !!table &&
    dest.url.trim().length > 0 &&
    includedList.length > 0 &&
    !(mode === 'selected' && (!singlePk || selectedKeys.size === 0)) &&
    !watchNeedsColumn;

  function buildInput(): HookInputDTO {
    const filters: FilterSpec[] = [];
    if (mode === 'selected' && singlePk) {
      filters.push({
        column: singlePk,
        operator: 'in',
        value: [...selectedKeys.values()],
      });
    }
    const sort: SortSpec[] | undefined = singlePk
      ? [{ column: singlePk, direction: 'asc' }]
      : undefined;

    const auth: HookInputDTO['destination']['auth'] =
      dest.authType === 'bearer'
        ? { type: 'bearer', token: dest.authToken }
        : dest.authType === 'header'
          ? {
              type: 'header',
              name: dest.authHeaderName,
              value: dest.authHeaderValue,
            }
          : { type: 'none' };
    const headerEntries = dest.headers
      .filter((h) => h.key.trim())
      .map((h) => [h.key.trim(), h.value] as const);

    const allIncluded = includedList.length === columns.length;

    return {
      name: name.trim() || `${table} → webhook`,
      source: {
        kind: 'table',
        connectionId,
        database: database || undefined,
        schema: schema || undefined,
        table,
        filters: filters.length ? filters : undefined,
        sort,
      },
      destination: {
        url: dest.url.trim(),
        method: dest.method,
        headers: headerEntries.length
          ? Object.fromEntries(headerEntries)
          : undefined,
        auth,
        idempotency: dest.idempotency,
      },
      transform: {
        template: '{{$row}}',
        fields: allIncluded ? undefined : includedList,
        wrapKey: wrapKey || undefined,
      },
      delivery: {
        batchSize: delivery.batchSize,
        maxAttempts: delivery.maxAttempts,
        minDelayMs: delivery.minDelayMs,
        timeoutMs: delivery.timeoutMs,
        onError: delivery.onError,
        backoffMs: 500,
        backoffMaxMs: 30000,
        pageSize: 200,
      },
      trigger:
        triggerKind === 'cdc'
          ? { kind: 'cdc', operations: [...cdcOps] }
          : triggerKind === 'watch'
            ? {
                kind: 'watch',
                strategy:
                  watchStrategy === 'snapshot'
                    ? { strategy: 'snapshot', maxTracked: 50000 }
                    : { strategy: watchStrategy, column: watchColumn },
                pollIntervalMs: Math.max(1000, Math.round(pollSeconds * 1000)),
                startFrom: watchStartFrom,
                maxPerPoll: 500,
              }
            : { kind: 'replay' },
      enabled: true,
    };
  }

  async function checkReadiness() {
    if (!connectionId || !table) return;
    setCheckingCdc(true);
    try {
      setReadiness(
        await api.cdcReadiness({
          connectionId,
          database: database || undefined,
          schema: schema || undefined,
          table,
        }),
      );
    } catch (err) {
      toast.error('Readiness check failed', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setCheckingCdc(false);
    }
  }

  async function handleSave() {
    try {
      const input = buildInput();
      if (editing) {
        await update.mutateAsync({ id: editing, input });
        toast.success('Hook updated');
      } else {
        const hook = await create.mutateAsync(input);
        selectHook(hook.id);
        toast.success('Hook created');
      }
      closeHookEditor();
    } catch (err) {
      toast.error('Could not save hook', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  if (!hookEditor.open) return null;
  const saving = create.isPending || update.isPending;

  return (
    <div className="bg-background fixed inset-0 z-40 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <Webhook className="text-primary h-5 w-5" />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Hook name"
          className="h-8 max-w-xs font-medium"
        />
        <div className="text-muted-foreground ml-2 text-sm">
          {builderKind === 'job'
            ? sendCount != null && (
                <span>
                  sends{' '}
                  <span className="text-foreground font-medium">
                    {sendCount.toLocaleString()}
                  </span>{' '}
                  {mode === 'selected' ? 'selected' : ''} row
                  {sendCount === 1 ? '' : 's'} · {includedList.length}/
                  {columns.length} columns
                </span>
              )
            : table && (
                <span>
                  streams new rows · {includedList.length}/{columns.length}{' '}
                  columns
                </span>
              )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={closeHookEditor}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? 'Save hook' : 'Create hook'}
          </Button>
        </div>
      </div>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* ---- Source / grid ---- */}
        <ResizablePanel defaultSize={64} minSize={40}>
          <div className="flex h-full flex-col">
            {/* source pickers */}
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <div className="flex items-center gap-1">
                <Select
                  value={connectionId}
                  onValueChange={(v) => {
                    setConnectionId(v);
                    setTable('');
                    setDatabase('');
                    setIncluded(new Set());
                    setFieldsPref(null);
                    setSelectedKeys(new Map());
                  }}
                >
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue placeholder="Connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {(connections?.length ?? 0) === 0 && (
                      <div className="text-muted-foreground px-2 py-1.5 text-xs">
                        No connections yet
                      </div>
                    )}
                    {connections?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {connectionId ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title="Edit connection"
                    onClick={() => openConnectionDialog(connectionId)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => openConnectionDialog()}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Connect a database
                  </Button>
                )}
              </div>

              {(databases?.length ?? 0) > 0 && (
                <Select
                  value={database || '__default'}
                  onValueChange={(v) => {
                    setDatabase(v === '__default' ? '' : v);
                    setTable('');
                    setIncluded(new Set());
                    setFieldsPref(null);
                  }}
                >
                  <SelectTrigger className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">(default db)</SelectItem>
                    {databases?.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <Select
                value={table}
                onValueChange={(v) => {
                  setTable(v);
                  setOffset(0);
                  setIncluded(new Set());
                  setFieldsPref(null);
                  setSelectedKeys(new Map());
                  setReadiness(null);
                }}
              >
                <SelectTrigger className="h-8 w-52">
                  <SelectValue placeholder="Table" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((t) => (
                    <SelectItem
                      key={`${t.schema ?? ''}.${t.name}`}
                      value={t.name}
                    >
                      {t.schema ? `${t.schema}.${t.name}` : t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {table && (
                <>
                  {builderKind === 'job' && (
                    <>
                      <div className="ml-2 flex items-center overflow-hidden rounded-md border text-xs">
                        {(['selected', 'all'] as const).map((m) => (
                          <button
                            key={m}
                            disabled={m === 'selected' && !singlePk}
                            onClick={() => setMode(m)}
                            className={cn(
                              'px-2.5 py-1.5 transition-colors disabled:opacity-40',
                              mode === m
                                ? 'bg-primary text-primary-foreground'
                                : 'hover:bg-accent',
                            )}
                            title={
                              m === 'selected' && !singlePk
                                ? 'Needs a single-column primary key'
                                : undefined
                            }
                          >
                            {m === 'selected' ? 'Selected rows' : 'All rows'}
                          </button>
                        ))}
                      </div>
                      {mode === 'selected' && (
                        <Badge variant="secondary" className="font-normal">
                          {selectedKeys.size} selected
                        </Badge>
                      )}
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-8 w-8"
                    onClick={() => refetch()}
                  >
                    {isFetching ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                  </Button>
                </>
              )}
            </div>

            {/* Hook-mode preview banner */}
            {builderKind === 'hook' && table && (
              <div className="flex items-start gap-2 border-b bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>Column selection only.</strong> New rows added to this
                  table will be delivered automatically — no row selection needed.
                  Click a column header to include or exclude it from the payload.
                </span>
              </div>
            )}

            {/* grid */}
            <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
              {!table ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                  {builderKind === 'hook'
                    ? 'Pick a connection and table to preview data and select columns.'
                    : 'Pick a connection and table to choose the data to send.'}
                </div>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-muted/95 sticky top-0 z-10 backdrop-blur">
                    <tr>
                      {mode === 'selected' && (
                        <th className="w-8 border-b border-r px-2 py-1.5">
                          <input
                            type="checkbox"
                            className="accent-primary h-3.5 w-3.5 cursor-pointer"
                            disabled={!singlePk}
                            checked={
                              rows.length > 0 &&
                              !!singlePk &&
                              rows.every((r) =>
                                selectedKeys.has(String(r[singlePk])),
                              )
                            }
                            onChange={togglePage}
                          />
                        </th>
                      )}
                      {columns.map((col) => {
                        const on = included.has(col.name);
                        return (
                          <th
                            key={col.name}
                            className={cn(
                              'border-b border-r px-3 py-1.5 text-left font-medium',
                              !on && 'opacity-40',
                            )}
                          >
                            <button
                              className="flex items-center gap-1.5 whitespace-nowrap"
                              onClick={() => toggleColumn(col.name)}
                              title={
                                on
                                  ? 'Included — click to exclude'
                                  : 'Excluded — click to include'
                              }
                            >
                              <span
                                className={cn(
                                  'flex h-3.5 w-3.5 items-center justify-center rounded border',
                                  on
                                    ? 'bg-primary border-primary text-primary-foreground'
                                    : 'border-muted-foreground/40',
                                )}
                              >
                                {on && <Check className="h-3 w-3" />}
                              </span>
                              <span>{col.name}</span>
                              {pk.includes(col.name) && (
                                <span className="text-[10px] text-amber-500">
                                  PK
                                </span>
                              )}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const isSel =
                        !!singlePk && selectedKeys.has(String(row[singlePk]));
                      return (
                        <tr
                          key={i}
                          className={cn(
                            'hover:bg-accent/40',
                            mode === 'selected' && isSel && 'bg-primary/5',
                          )}
                        >
                          {mode === 'selected' && (
                            <td className="border-b border-r px-2 text-center">
                              <input
                                type="checkbox"
                                className="accent-primary h-3.5 w-3.5 cursor-pointer"
                                disabled={!singlePk}
                                checked={isSel}
                                onChange={() => toggleRow(row)}
                              />
                            </td>
                          )}
                          {columns.map((col) => (
                            <td
                              key={col.name}
                              className={cn(
                                'max-w-[360px] border-b border-r px-3 py-1',
                                !included.has(col.name) && 'opacity-40',
                              )}
                            >
                              <span
                                className={cn(
                                  'block truncate font-mono text-xs',
                                  row[col.name] == null &&
                                    'text-muted-foreground/60 italic',
                                )}
                                title={formatCell(row[col.name])}
                              >
                                {formatCell(row[col.name])}
                              </span>
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* pagination */}
            {table && (
              <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-xs">
                <span>
                  {builderKind === 'hook' ? 'preview rows ' : 'rows '}
                  {rows.length ? offset + 1 : 0}–{offset + rows.length}
                  {builderKind === 'job' && browse?.total != null
                    ? ` of ${browse.estimated ? '~' : ''}${browse.total.toLocaleString()}`
                    : ''}
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={!browse?.hasMore}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* ---- Config ---- */}
        <ResizablePanel defaultSize={36} minSize={26}>
          <div className="h-full overflow-y-auto">
            <div className="space-y-5 p-4">
              {/* Trigger — hooks only; jobs are always a one-shot replay. */}
              {builderKind === 'hook' && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">How it listens</h3>
                  <div className="flex overflow-hidden rounded-md border text-xs">
                    {(
                      [
                        ['watch', 'Polling'],
                        ['cdc', 'Event-based (real-time)'],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => setTriggerKind(k)}
                        className={cn(
                          'flex-1 px-2.5 py-1.5 transition-colors',
                          triggerKind === k
                            ? 'bg-accent font-medium'
                            : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {triggerKind === 'cdc' && (
                    <div className="grid gap-2 rounded-md border p-2.5">
                    <Label className="text-xs">Operations to deliver</Label>
                    <div className="flex gap-3 text-xs">
                      {(['insert', 'update', 'delete'] as const).map((op) => (
                        <label key={op} className="flex items-center gap-1.5 capitalize">
                          <input
                            type="checkbox"
                            className="accent-primary h-3.5 w-3.5"
                            checked={cdcOps.has(op)}
                            onChange={() =>
                              setCdcOps((prev) => {
                                const next = new Set(prev);
                                if (next.has(op)) next.delete(op);
                                else next.add(op);
                                return next;
                              })
                            }
                          />
                          {op}
                        </label>
                      ))}
                    </div>

                    {/* Readiness / setup */}
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground text-[11px]">
                        Streams changes from the DB log in real time (no polling).
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={!connectionId || !table || checkingCdc}
                        onClick={checkReadiness}
                      >
                        {checkingCdc ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Check readiness
                      </Button>
                    </div>

                    {readiness && (
                      <div className="space-y-1.5 rounded-md border p-2 text-[11px]">
                        {!readiness.supported ? (
                          <p className="text-amber-600">
                            {readiness.instructions[0]}
                          </p>
                        ) : (
                          <>
                            <p
                              className={cn(
                                'font-medium',
                                readiness.ready ? 'text-emerald-600' : 'text-amber-600',
                              )}
                            >
                              {readiness.ready
                                ? '✓ Ready — we’ll auto-create the publication & slot on start.'
                                : 'Setup needed:'}
                            </p>
                            {readiness.checks.map((c) => (
                              <div key={c.label} className="flex items-center gap-1.5">
                                <span className={c.ok ? 'text-emerald-600' : 'text-destructive'}>
                                  {c.ok ? '✓' : '✗'}
                                </span>
                                <span>
                                  {c.label}
                                  {c.detail ? ` (${c.detail})` : ''}
                                </span>
                              </div>
                            ))}
                            {readiness.instructions.map((ins, i) => (
                              <p key={i} className="text-muted-foreground pl-1">
                                • {ins}
                              </p>
                            ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {triggerKind === 'watch' && (
                  <div className="grid gap-2 rounded-md border p-2.5">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Detect new rows by</Label>
                      <Select
                        value={watchStrategy}
                        onValueChange={(v) =>
                          setWatchStrategy(v as 'increment' | 'timestamp' | 'snapshot')
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="increment">
                            Incrementing column (id / sequence)
                          </SelectItem>
                          <SelectItem value="timestamp">
                            Timestamp column (created/updated at)
                          </SelectItem>
                          <SelectItem value="snapshot">
                            New primary keys (small tables / UUIDs)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {watchStrategy !== 'snapshot' && (
                      <div className="grid gap-1.5">
                        <Label className="text-xs">
                          {watchStrategy === 'timestamp' ? 'Timestamp' : 'Incrementing'}{' '}
                          column
                        </Label>
                        <Select value={watchColumn} onValueChange={setWatchColumn}>
                          <SelectTrigger className="h-8">
                            <SelectValue placeholder="Select a column" />
                          </SelectTrigger>
                          <SelectContent>
                            {columns.map((c) => (
                              <SelectItem key={c.name} value={c.name}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <NumField
                        label="Poll every (sec)"
                        value={pollSeconds}
                        min={1}
                        onChange={setPollSeconds}
                      />
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Start from</Label>
                        <Select
                          value={watchStartFrom}
                          onValueChange={(v) =>
                            setWatchStartFrom(v as 'now' | 'beginning')
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="now">New rows from now</SelectItem>
                            <SelectItem value="beginning">All existing + new</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                      <p className="text-muted-foreground text-[11px]">
                        The hook keeps polling this table and delivers new rows as
                        they appear.
                      </p>
                    </div>
                  )}
                </section>
              )}

              {/* Payload */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">What gets sent</h3>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Wrap under key (optional)</Label>
                    <Input
                      value={wrapKey}
                      placeholder="e.g. data"
                      className="h-8"
                      onChange={(e) => setWrapKey(e.target.value)}
                    />
                  </div>
                </div>
                {preview?.error ? (
                  <p className="text-destructive mt-2 text-xs">
                    {preview.error}
                  </p>
                ) : preview ? (
                  <div className="mt-2 space-y-2">
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs">
                        Schema (types)
                      </p>
                      <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">
                        {JSON.stringify(preview.schema, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs">
                        Sample payload (one row)
                      </p>
                      <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">
                        {JSON.stringify(preview.body, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground mt-2 text-xs">
                    Select a table and include at least one column to preview.
                  </p>
                )}
              </section>

              {/* Destination */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Destination</h3>
                <div className="grid grid-cols-[90px_1fr] gap-2">
                  <Select
                    value={dest.method}
                    onValueChange={(v) =>
                      setDest((d) => ({
                        ...d,
                        method: v as Destination['method'],
                      }))
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="PATCH">PATCH</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={dest.url}
                    placeholder="https://api.example.com/webhook"
                    className="h-8"
                    onChange={(e) =>
                      setDest((d) => ({ ...d, url: e.target.value }))
                    }
                  />
                </div>

                <Select
                  value={dest.authType}
                  onValueChange={(v) =>
                    setDest((d) => ({ ...d, authType: v as AuthType }))
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No auth</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                    <SelectItem value="header">Custom header</SelectItem>
                  </SelectContent>
                </Select>
                {dest.authType === 'bearer' && (
                  <Input
                    type="password"
                    className="h-8"
                    placeholder="Token"
                    value={dest.authToken}
                    onChange={(e) =>
                      setDest((d) => ({ ...d, authToken: e.target.value }))
                    }
                  />
                )}
                {dest.authType === 'header' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      className="h-8"
                      placeholder="X-API-Key"
                      value={dest.authHeaderName}
                      onChange={(e) =>
                        setDest((d) => ({
                          ...d,
                          authHeaderName: e.target.value,
                        }))
                      }
                    />
                    <Input
                      className="h-8"
                      type="password"
                      placeholder="Value"
                      value={dest.authHeaderValue}
                      onChange={(e) =>
                        setDest((d) => ({
                          ...d,
                          authHeaderValue: e.target.value,
                        }))
                      }
                    />
                  </div>
                )}

                {dest.headers.map((h, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_1fr_auto] gap-1.5"
                  >
                    <Input
                      className="h-8"
                      placeholder="Header"
                      value={h.key}
                      onChange={(e) =>
                        setDest((d) => ({
                          ...d,
                          headers: d.headers.map((x, j) =>
                            j === i ? { ...x, key: e.target.value } : x,
                          ),
                        }))
                      }
                    />
                    <Input
                      className="h-8"
                      placeholder="Value"
                      value={h.value}
                      onChange={(e) =>
                        setDest((d) => ({
                          ...d,
                          headers: d.headers.map((x, j) =>
                            j === i ? { ...x, value: e.target.value } : x,
                          ),
                        }))
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        setDest((d) => ({
                          ...d,
                          headers: d.headers.filter((_, j) => j !== i),
                        }))
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() =>
                    setDest((d) => ({
                      ...d,
                      headers: [...d.headers, { key: '', value: '' }],
                    }))
                  }
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Header
                </Button>

                <label className="flex items-center justify-between rounded-md border p-2.5">
                  <span className="text-xs">
                    Send <code>Idempotency-Key</code>
                  </span>
                  <Switch
                    checked={dest.idempotency}
                    onCheckedChange={(v) =>
                      setDest((d) => ({ ...d, idempotency: v }))
                    }
                  />
                </label>
              </section>

              {/* Delivery */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Delivery</h3>
                <div className="grid grid-cols-2 gap-2">
                  {builderKind === 'job' && (
                    <NumField
                      label="Batch size"
                      value={delivery.batchSize}
                      min={1}
                      onChange={(v) =>
                        setDelivery((d) => ({ ...d, batchSize: v }))
                      }
                    />
                  )}
                  <NumField
                    label="Max attempts"
                    value={delivery.maxAttempts}
                    min={1}
                    onChange={(v) =>
                      setDelivery((d) => ({ ...d, maxAttempts: v }))
                    }
                  />
                  {builderKind === 'job' && (
                    <NumField
                      label="Delay between (ms)"
                      value={delivery.minDelayMs}
                      min={0}
                      onChange={(v) =>
                        setDelivery((d) => ({ ...d, minDelayMs: v }))
                      }
                    />
                  )}
                  <NumField
                    label="Timeout (ms)"
                    value={delivery.timeoutMs}
                    min={100}
                    onChange={(v) =>
                      setDelivery((d) => ({ ...d, timeoutMs: v }))
                    }
                  />
                </div>
                {/* On-failure abort is a job concept — a listener must never stop on one bad delivery. */}
                {builderKind === 'job' && (
                  <div className="grid gap-1.5">
                    <Label className="text-xs">On failure</Label>
                    <Select
                      value={delivery.onError}
                      onValueChange={(v) =>
                        setDelivery((d) => ({
                          ...d,
                          onError: v as 'continue' | 'abort',
                        }))
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="continue">
                          Log &amp; continue
                        </SelectItem>
                        <SelectItem value="abort">Stop the run</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </section>
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function NumField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        className="h-8"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
