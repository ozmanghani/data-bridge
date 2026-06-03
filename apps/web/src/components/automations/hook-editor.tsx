'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, X, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { renderRow, type HookInputDTO, type TableSchema } from '@relay/core';
import { api, ApiError } from '@/lib/api';
import {
  useConnections,
  useCreateHook,
  useDatabases,
  useSchema,
  useUpdateHook,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const DEFAULT_TEMPLATE = '{{$row}}';

interface HeaderPair {
  key: string;
  value: string;
}

interface FormState {
  name: string;
  sourceKind: 'table' | 'query';
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  sortColumn: string;
  sortDir: 'asc' | 'desc';
  statement: string;
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: HeaderPair[];
  authType: 'none' | 'bearer' | 'header';
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  idempotency: boolean;
  template: string;
  wrapKey: string;
  fields: string;
  batchSize: number;
  maxAttempts: number;
  minDelayMs: number;
  timeoutMs: number;
  pageSize: number;
  backoffMs: number;
  backoffMaxMs: number;
  onError: 'continue' | 'abort';
  enabled: boolean;
}

function blankForm(): FormState {
  return {
    name: '',
    sourceKind: 'table',
    connectionId: '',
    database: '',
    schema: '',
    table: '',
    sortColumn: '',
    sortDir: 'asc',
    statement: '',
    url: '',
    method: 'POST',
    headers: [],
    authType: 'none',
    authToken: '',
    authHeaderName: '',
    authHeaderValue: '',
    idempotency: false,
    template: DEFAULT_TEMPLATE,
    wrapKey: '',
    fields: '',
    batchSize: 1,
    maxAttempts: 3,
    minDelayMs: 0,
    timeoutMs: 15000,
    pageSize: 200,
    backoffMs: 500,
    backoffMaxMs: 30000,
    onError: 'continue',
    enabled: true,
  };
}

export function HookEditor() {
  const { hookEditor, closeHookEditor, selectHook } = useStudio();
  const create = useCreateHook();
  const update = useUpdateHook();
  const [form, setForm] = useState<FormState>(blankForm);
  const editing = hookEditor.editingId;

  const { data: connections } = useConnections();
  const { data: databases } = useDatabases(form.connectionId || null);
  const { data: schema } = useSchema(
    form.connectionId || null,
    form.database || undefined,
  );

  /* Populate form on open. */
  useEffect(() => {
    if (!hookEditor.open) return;
    if (editing) {
      void api.getHook(editing).then((h) => setForm(fromHook(h)));
      return;
    }
    const base = blankForm();
    if (hookEditor.seed) {
      base.sourceKind = 'table';
      base.connectionId = hookEditor.seed.connectionId;
      base.database = hookEditor.seed.database ?? '';
      base.schema = hookEditor.seed.schema ?? '';
      base.table = hookEditor.seed.table;
      base.name = `${hookEditor.seed.table} → webhook`;
    }
    setForm(base);
  }, [hookEditor.open, editing, hookEditor.seed]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /* All tables across namespaces, for the table picker. */
  const tables = useMemo<TableSchema[]>(
    () => schema?.namespaces.flatMap((ns) => ns.tables) ?? [],
    [schema],
  );
  const selectedTable = tables.find((t) => t.name === form.table);
  const columns = selectedTable?.columns.map((c) => c.name) ?? [];

  function buildInput(): HookInputDTO {
    const source: HookInputDTO['source'] =
      form.sourceKind === 'table'
        ? {
            kind: 'table',
            connectionId: form.connectionId,
            database: form.database || undefined,
            schema: form.schema || undefined,
            table: form.table,
            sort: form.sortColumn
              ? [{ column: form.sortColumn, direction: form.sortDir }]
              : undefined,
          }
        : {
            kind: 'query',
            connectionId: form.connectionId,
            database: form.database || undefined,
            statement: form.statement,
          };

    const auth: HookInputDTO['destination']['auth'] =
      form.authType === 'bearer'
        ? { type: 'bearer', token: form.authToken }
        : form.authType === 'header'
          ? {
              type: 'header',
              name: form.authHeaderName,
              value: form.authHeaderValue,
            }
          : { type: 'none' };

    const headerEntries = form.headers
      .filter((h) => h.key.trim())
      .map((h) => [h.key.trim(), h.value] as const);

    return {
      name: form.name.trim() || 'Untitled hook',
      source,
      destination: {
        url: form.url.trim(),
        method: form.method,
        headers: headerEntries.length
          ? Object.fromEntries(headerEntries)
          : undefined,
        auth,
        idempotency: form.idempotency,
      },
      transform: {
        template: form.template || DEFAULT_TEMPLATE,
        wrapKey: form.wrapKey || undefined,
        fields: form.fields.trim()
          ? form.fields
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      },
      delivery: {
        batchSize: form.batchSize,
        maxAttempts: form.maxAttempts,
        minDelayMs: form.minDelayMs,
        timeoutMs: form.timeoutMs,
        pageSize: form.pageSize,
        backoffMs: form.backoffMs,
        backoffMaxMs: form.backoffMaxMs,
        onError: form.onError,
      },
      enabled: form.enabled,
    };
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

  const saving = create.isPending || update.isPending;

  return (
    <Dialog
      open={hookEditor.open}
      onOpenChange={(o) => !o && closeHookEditor()}
    >
      <DialogContent className="max-h-[88vh] gap-0 overflow-hidden p-0 sm:max-w-[680px]">
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle>{editing ? 'Edit hook' : 'New hook'}</DialogTitle>
          <DialogDescription>
            Stream rows from a database to an HTTP endpoint with a templated
            payload.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 px-5 py-3">
          <Label htmlFor="hook-name">Name</Label>
          <Input
            id="hook-name"
            value={form.name}
            placeholder="Sync users to CRM"
            onChange={(e) => set('name', e.target.value)}
          />
        </div>

        <Tabs defaultValue="source" className="flex min-h-0 flex-col">
          <TabsList className="mx-5 grid w-auto grid-cols-4">
            <TabsTrigger value="source">Source</TabsTrigger>
            <TabsTrigger value="destination">Destination</TabsTrigger>
            <TabsTrigger value="payload">Payload</TabsTrigger>
            <TabsTrigger value="delivery">Delivery</TabsTrigger>
          </TabsList>

          <div className="max-h-[46vh] overflow-y-auto px-5 py-4">
            {/* ---- Source ---- */}
            <TabsContent value="source" className="mt-0 grid gap-4">
              <div className="grid gap-2">
                <Label>Connection</Label>
                <Select
                  value={form.connectionId}
                  onValueChange={(v) => set('connectionId', v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {(databases?.length ?? 0) > 0 && (
                <div className="grid gap-2">
                  <Label>Database</Label>
                  <Select
                    value={form.database || '__default'}
                    onValueChange={(v) =>
                      set('database', v === '__default' ? '' : v)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default">
                        (connection default)
                      </SelectItem>
                      {databases?.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid gap-2">
                <Label>Source type</Label>
                <Select
                  value={form.sourceKind}
                  onValueChange={(v) =>
                    set('sourceKind', v as 'table' | 'query')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="table">
                      Table — replay every row
                    </SelectItem>
                    <SelectItem value="query">
                      Query — replay a result set
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.sourceKind === 'table' ? (
                <>
                  <div className="grid gap-2">
                    <Label>Table</Label>
                    <Select
                      value={form.table}
                      onValueChange={(v) => set('table', v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a table" />
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
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label>Order by</Label>
                      <Select
                        value={form.sortColumn || '__pk'}
                        onValueChange={(v) =>
                          set('sortColumn', v === '__pk' ? '' : v)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__pk">
                            Primary key (default)
                          </SelectItem>
                          {columns.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Direction</Label>
                      <Select
                        value={form.sortDir}
                        onValueChange={(v) =>
                          set('sortDir', v as 'asc' | 'desc')
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asc">Ascending</SelectItem>
                          <SelectItem value="desc">Descending</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Rows are paged in a stable order so each is delivered
                    exactly once. Tables without a primary key need an explicit
                    order.
                  </p>
                </>
              ) : (
                <div className="grid gap-2">
                  <Label>Query</Label>
                  <Textarea
                    value={form.statement}
                    placeholder="SELECT * FROM users WHERE active = true"
                    className="font-mono text-xs"
                    rows={5}
                    onChange={(e) => set('statement', e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    The full result is streamed once (bounded by the server row
                    cap).
                  </p>
                </div>
              )}
            </TabsContent>

            {/* ---- Destination ---- */}
            <TabsContent value="destination" className="mt-0 grid gap-4">
              <div className="grid grid-cols-[110px_1fr] gap-3">
                <div className="grid gap-2">
                  <Label>Method</Label>
                  <Select
                    value={form.method}
                    onValueChange={(v) =>
                      set('method', v as FormState['method'])
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="PATCH">PATCH</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Endpoint URL</Label>
                  <Input
                    value={form.url}
                    placeholder="https://api.example.com/webhooks/relay"
                    onChange={(e) => set('url', e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Authentication</Label>
                <Select
                  value={form.authType}
                  onValueChange={(v) =>
                    set('authType', v as FormState['authType'])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                    <SelectItem value="header">Custom header</SelectItem>
                  </SelectContent>
                </Select>
                {form.authType === 'bearer' && (
                  <Input
                    type="password"
                    value={form.authToken}
                    placeholder="Token"
                    onChange={(e) => set('authToken', e.target.value)}
                  />
                )}
                {form.authType === 'header' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={form.authHeaderName}
                      placeholder="X-API-Key"
                      onChange={(e) => set('authHeaderName', e.target.value)}
                    />
                    <Input
                      type="password"
                      value={form.authHeaderValue}
                      placeholder="Value"
                      onChange={(e) => set('authHeaderValue', e.target.value)}
                    />
                  </div>
                )}
                <p className="text-muted-foreground text-xs">
                  Secrets are encrypted at rest, never returned to the browser.
                </p>
              </div>

              <div className="grid gap-2">
                <Label>Custom headers</Label>
                {form.headers.map((h, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <Input
                      value={h.key}
                      placeholder="Header"
                      onChange={(e) =>
                        set(
                          'headers',
                          form.headers.map((x, j) =>
                            j === i ? { ...x, key: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <Input
                      value={h.value}
                      placeholder="Value"
                      onChange={(e) =>
                        set(
                          'headers',
                          form.headers.map((x, j) =>
                            j === i ? { ...x, value: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        set(
                          'headers',
                          form.headers.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() =>
                    set('headers', [...form.headers, { key: '', value: '' }])
                  }
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add header
                </Button>
              </div>

              <label className="flex items-center justify-between rounded-md border p-3">
                <span className="text-sm">
                  Send <code className="text-xs">Idempotency-Key</code> header
                  <span className="text-muted-foreground block text-xs">
                    Lets the receiver dedupe redeliveries on resume.
                  </span>
                </span>
                <Switch
                  checked={form.idempotency}
                  onCheckedChange={(v) => set('idempotency', v)}
                />
              </label>
            </TabsContent>

            {/* ---- Payload ---- */}
            <TabsContent value="payload" className="mt-0 grid gap-4">
              <PayloadEditor form={form} set={set} />
            </TabsContent>

            {/* ---- Delivery ---- */}
            <TabsContent
              value="delivery"
              className="mt-0 grid grid-cols-2 gap-4"
            >
              <NumberField
                label="Batch size"
                hint="Rows per request (1 = one-by-one)"
                value={form.batchSize}
                onChange={(v) => set('batchSize', v)}
                min={1}
              />
              <NumberField
                label="Max attempts"
                hint="Retries per request"
                value={form.maxAttempts}
                onChange={(v) => set('maxAttempts', v)}
                min={1}
              />
              <NumberField
                label="Delay between sends (ms)"
                hint="Rate limit"
                value={form.minDelayMs}
                onChange={(v) => set('minDelayMs', v)}
                min={0}
              />
              <NumberField
                label="Request timeout (ms)"
                value={form.timeoutMs}
                onChange={(v) => set('timeoutMs', v)}
                min={100}
              />
              <NumberField
                label="Page size"
                hint="Rows fetched per page"
                value={form.pageSize}
                onChange={(v) => set('pageSize', v)}
                min={1}
              />
              <NumberField
                label="Backoff base (ms)"
                value={form.backoffMs}
                onChange={(v) => set('backoffMs', v)}
                min={0}
              />
              <div className="grid gap-2">
                <Label>On delivery failure</Label>
                <Select
                  value={form.onError}
                  onValueChange={(v) =>
                    set('onError', v as 'continue' | 'abort')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="continue">Log & continue</SelectItem>
                    <SelectItem value="abort">Stop the run</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-end justify-between gap-2 pb-1">
                <span className="text-sm">Enabled</span>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => set('enabled', v)}
                />
              </label>
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="ghost" onClick={closeHookEditor}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

function PayloadEditor({
  form,
  set,
}: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  const [preview, setPreview] = useState<{
    bodies: unknown[];
    warnings: string[];
    error?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function runPreview() {
    setLoading(true);
    setPreview(null);
    try {
      let rows: Record<string, unknown>[];
      if (form.sourceKind === 'table') {
        const page = await api.browse(
          form.connectionId,
          {
            schema: form.schema || undefined,
            table: form.table,
            limit: 3,
            offset: 0,
            sort: form.sortColumn
              ? [{ column: form.sortColumn, direction: form.sortDir }]
              : undefined,
          },
          form.database || undefined,
        );
        rows = page.rows;
      } else {
        const result = await api.runQuery(
          form.connectionId,
          form.statement,
          [],
          form.database || undefined,
        );
        rows = result.rows.slice(0, 3);
      }

      const transform = {
        template: form.template || DEFAULT_TEMPLATE,
        wrapKey: form.wrapKey || undefined,
        fields: form.fields.trim()
          ? form.fields
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      };
      const table = form.sourceKind === 'table' ? form.table : '(query)';
      const now = new Date().toISOString();
      const warnings = new Set<string>();
      const bodies = rows.map((row, index) => {
        const r = renderRow(row, transform, { table, now, index });
        r.warnings.forEach((w) => warnings.add(w));
        return r.body;
      });
      setPreview({ bodies, warnings: [...warnings] });
    } catch (err) {
      setPreview({
        bodies: [],
        warnings: [],
        error: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="grid gap-2">
        <Label>Payload template (JSON)</Label>
        <Textarea
          value={form.template}
          className="font-mono text-xs"
          rows={6}
          onChange={(e) => set('template', e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Tokens: <code>{'{{column}}'}</code>, <code>{'{{$row}}'}</code> (whole
          row), <code>{'{{$table}}'}</code>, <code>{'{{$now}}'}</code>,{' '}
          <code>{'{{$index}}'}</code>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label>Wrap under key (optional)</Label>
          <Input
            value={form.wrapKey}
            placeholder="data"
            onChange={(e) => set('wrapKey', e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label>Fields for {'{{$row}}'} (optional)</Label>
          <Input
            value={form.fields}
            placeholder="id, email, name"
            onChange={(e) => set('fields', e.target.value)}
          />
        </div>
      </div>

      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={runPreview}
          disabled={loading || !form.connectionId}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eye className="mr-1.5 h-3.5 w-3.5" />
          )}
          Preview with live data
        </Button>
      </div>

      {preview?.error && (
        <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
          {preview.error}
        </p>
      )}
      {preview && !preview.error && (
        <div className="grid gap-2">
          {preview.warnings.length > 0 && (
            <p className="text-xs text-amber-600">
              Unresolved tokens: {preview.warnings.join(', ')}
            </p>
          )}
          <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 font-mono text-xs">
            {preview.bodies.length === 0
              ? 'No sample rows returned.'
              : preview.bodies
                  .map((b) => JSON.stringify(b, null, 2))
                  .join('\n\n──────────\n\n')}
          </pre>
        </div>
      )}
    </>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function fromHook(h: import('@relay/core').Hook): FormState {
  const f = blankForm();
  f.name = h.name;
  f.sourceKind = h.source.kind;
  f.connectionId = h.source.connectionId;
  f.database = h.source.database ?? '';
  if (h.source.kind === 'table') {
    f.schema = h.source.schema ?? '';
    f.table = h.source.table;
    const sort = h.source.sort?.[0];
    if (sort) {
      f.sortColumn = sort.column;
      f.sortDir = sort.direction;
    }
  } else {
    f.statement = h.source.statement;
  }
  f.url = h.destination.url;
  f.method = h.destination.method;
  f.headers = Object.entries(h.destination.headers ?? {}).map(
    ([key, value]) => ({
      key,
      value,
    }),
  );
  f.idempotency = h.destination.idempotency;
  if (h.destination.auth.type === 'bearer') {
    f.authType = 'bearer';
    f.authToken = h.destination.auth.token;
  } else if (h.destination.auth.type === 'header') {
    f.authType = 'header';
    f.authHeaderName = h.destination.auth.name;
    f.authHeaderValue = h.destination.auth.value;
  }
  f.template = h.transform.template;
  f.wrapKey = h.transform.wrapKey ?? '';
  f.fields = (h.transform.fields ?? []).join(', ');
  f.batchSize = h.delivery.batchSize;
  f.maxAttempts = h.delivery.maxAttempts;
  f.minDelayMs = h.delivery.minDelayMs;
  f.timeoutMs = h.delivery.timeoutMs;
  f.pageSize = h.delivery.pageSize;
  f.backoffMs = h.delivery.backoffMs;
  f.backoffMaxMs = h.delivery.backoffMaxMs;
  f.onError = h.delivery.onError;
  f.enabled = h.enabled;
  return f;
}
