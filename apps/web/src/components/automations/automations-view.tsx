'use client';

import { useEffect, useState } from 'react';
import { Pencil, Play, Radio, Square, Trash2, Webhook, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  useDeleteHook,
  useHookRuns,
  useHooks,
  useStartHookRun,
  useStartWatch,
  useStopWatch,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { RunDetail, RunStatusBadge } from './run-detail';

export function AutomationsView() {
  const { selectedHookId, selectHook, openHookEditor } = useStudio();
  const { data: hooks } = useHooks();
  const hook = hooks?.find((h) => h.id === selectedHookId) ?? null;

  if (!hook) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <Webhook className="h-10 w-10 opacity-40" />
        <div>
          <p className="text-sm">No hook selected</p>
          <p className="text-xs">
            Pick a hook on the left, or{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => openHookEditor()}
            >
              create one
            </button>
            .
          </p>
        </div>
      </div>
    );
  }

  const destHostname = (() => {
    try {
      return new URL(hook.destination.url).hostname;
    } catch {
      return hook.destination.url;
    }
  })();

  return (
    <HookPanel
      key={hook.id}
      hookId={hook.id}
      hookName={hook.name}
      sourceLabel={hook.source.kind === 'table' ? hook.source.table : 'custom query'}
      destLabel={`${hook.destination.method} ${destHostname}`}
      endpoint={{ url: hook.destination.url, method: hook.destination.method }}
      isWatch={hook.trigger.kind !== 'replay'}
      onDeleted={() => selectHook(null)}
    />
  );
}

function HookPanel({
  hookId,
  hookName,
  sourceLabel,
  destLabel,
  endpoint,
  isWatch,
  onDeleted,
}: {
  hookId: string;
  hookName: string;
  sourceLabel: string;
  destLabel: string;
  endpoint: { url: string; method: string };
  isWatch: boolean;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const { openHookEditor } = useStudio();
  const start = useStartHookRun(hookId);
  const startWatch = useStartWatch(hookId);
  const stopWatch = useStopWatch(hookId);
  const del = useDeleteHook();
  const { data: runs } = useHookRuns(hookId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const listening = !!runs?.some((r) =>
    ['queued', 'running', 'canceling'].includes(r.status),
  );

  // Default to (and follow) the most recent run.
  useEffect(() => {
    if (!runs || runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId((cur) =>
      cur && runs.some((r) => r.id === cur) ? cur : runs[0]!.id,
    );
  }, [runs]);

  const selectedRun = runs?.find((r) => r.id === selectedRunId) ?? null;

  async function handleRun() {
    try {
      const run = await start.mutateAsync({});
      setSelectedRunId(run.id);
      toast.success('Run started');
    } catch (err) {
      toast.error('Could not start run', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleStartWatch() {
    try {
      const run = await startWatch.mutateAsync();
      setSelectedRunId(run.id);
      toast.success('Listening for new data');
    } catch (err) {
      toast.error('Could not start listening', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleStopWatch() {
    try {
      await stopWatch.mutateAsync();
      toast.success('Stopped listening');
    } catch (err) {
      toast.error('Could not stop', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete "${hookName}"?`,
      description: 'This removes the hook and its run history. This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(hookId);
      onDeleted();
      toast.success('Hook deleted');
    } catch (err) {
      toast.error('Could not delete', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{hookName}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {sourceLabel} → {destLabel}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isWatch ? (
            listening ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleStopWatch}
                disabled={stopWatch.isPending}
              >
                {stopWatch.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                )}
                Stop listening
              </Button>
            ) : (
              <Button size="sm" onClick={handleStartWatch} disabled={startWatch.isPending}>
                {startWatch.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radio className="mr-1.5 h-3.5 w-3.5" />
                )}
                Start listening
              </Button>
            )
          ) : (
            <Button size="sm" onClick={handleRun} disabled={start.isPending}>
              {start.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Run
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => openHookEditor({ editingId: hookId })}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Runs strip */}
      <div className="flex items-center gap-2 overflow-x-auto border-b px-4 py-2">
        {(!runs || runs.length === 0) && (
          <p className="text-xs text-muted-foreground">
            {isWatch
              ? 'Not listening yet — press Start listening to stream changes as they happen.'
              : 'No runs yet — press Run to stream rows to the endpoint.'}
          </p>
        )}
        {runs?.map((run) => (
          <button
            key={run.id}
            onClick={() => setSelectedRunId(run.id)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors',
              selectedRunId === run.id
                ? 'border-primary bg-accent'
                : 'border-transparent hover:bg-accent/50',
            )}
          >
            <RunStatusBadge status={run.status} />
            <span className="text-muted-foreground">
              {new Date(run.startedAt).toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      {/* Selected run */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedRun ? (
          <RunDetail
            hookId={hookId}
            run={selectedRun}
            endpoint={endpoint}
            isHook={isWatch}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a run to see its delivery log.
          </div>
        )}
      </div>
    </div>
  );
}
