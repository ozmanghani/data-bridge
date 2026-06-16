'use client';

import { Ban, Loader2, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { HookRun, HookRunStatus } from '@relay/core';
import { ApiError } from '@/lib/api';
import { useCancelHookRun, useRetryFailed, useStartHookRun } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DeliveryMonitor } from './delivery-log';

const STATUS_STYLES: Record<HookRunStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  canceling: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  canceled: 'bg-muted text-muted-foreground',
  paused: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  interrupted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

export function RunStatusBadge({ status }: { status: HookRunStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_STYLES[status],
      )}
    >
      {(status === 'running' || status === 'queued' || status === 'canceling') && (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {status}
    </span>
  );
}

const ACTIVE: HookRunStatus[] = ['queued', 'running', 'canceling'];
const RESUMABLE: HookRunStatus[] = ['failed', 'canceled', 'paused', 'interrupted'];

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'success' | 'danger' | 'warn' | 'muted';
}) {
  return (
    <div className="bg-card flex flex-col rounded-lg border px-3 py-2">
      <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
        {label}
      </span>
      <span
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'danger' && 'text-destructive',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function RunDetail({
  hookId,
  run,
  endpoint,
  isHook,
}: {
  hookId: string;
  run: HookRun;
  endpoint: { url: string; method: string };
  /** Hooks (watch/CDC) are continuous listeners: no Cancel/Resume, no progress. */
  isHook: boolean;
}) {
  const cancel = useCancelHookRun(hookId);
  const startRun = useStartHookRun(hookId);
  const retryFailed = useRetryFailed(hookId);

  const isActive = ACTIVE.includes(run.status);
  const total = run.totalCount;
  const settled = run.sentCount + run.failedCount + run.skippedCount;
  const pending = total != null ? Math.max(0, total - settled) : null;
  const pct = total && total > 0 ? Math.min(100, Math.round((settled / total) * 100)) : null;
  const attempted = run.sentCount + run.failedCount;
  const successRate =
    attempted > 0 ? Math.round((run.sentCount / attempted) * 100) : null;

  async function handleCancel() {
    try {
      await cancel.mutateAsync(run.id);
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleResume() {
    try {
      await startRun.mutateAsync({ resumeRunId: run.id });
      toast.success('Run resumed');
    } catch (err) {
      toast.error('Could not resume', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleRetry() {
    try {
      await retryFailed.mutateAsync(run.id);
      toast.success('Resending failed deliveries with the current config');
    } catch (err) {
      toast.error('Could not retry', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  // Available whenever there are failures — including a live (CDC/watch) run.
  const canRetry = run.failedCount > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: status + actions */}
      <div className="flex items-center gap-3 px-4 pt-3">
        <RunStatusBadge status={run.status} />
        <span className="text-muted-foreground text-xs">
          {isHook
            ? isActive
              ? `listening since ${new Date(run.startedAt).toLocaleString()}`
              : `last active ${new Date(run.startedAt).toLocaleString()}`
            : `started ${new Date(run.startedAt).toLocaleString()}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* Cancel/Resume are job controls. A hook is started/stopped from the
              panel header above — "resuming" one would re-stream the whole table. */}
          {!isHook && isActive && (
            <Button size="sm" variant="outline" onClick={handleCancel} disabled={cancel.isPending}>
              {cancel.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="mr-1.5 h-3.5 w-3.5" />
              )}
              Cancel
            </Button>
          )}
          {canRetry && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetry}
              disabled={retryFailed.isPending}
            >
              {retryFailed.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Retry failed ({run.failedCount})
            </Button>
          )}
          {!isHook && RESUMABLE.includes(run.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleResume}
              disabled={startRun.isPending}
            >
              {startRun.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Resume
            </Button>
          )}
        </div>
      </div>

      {/* Stat cards — a listener has no finite total/queue, so it shows a
          delivered/failed/skipped breakdown instead of progress-to-completion. */}
      {isHook ? (
        <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-4">
          <Stat label="Delivered" value={run.sentCount.toLocaleString()} tone="success" />
          <Stat label="Failed" value={run.failedCount.toLocaleString()} tone="danger" />
          <Stat label="Skipped" value={run.skippedCount.toLocaleString()} tone="warn" />
          <Stat
            label="Success"
            value={successRate != null ? `${successRate}%` : '—'}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 px-4 py-3 sm:grid-cols-6">
            <Stat label="Total" value={total != null ? total.toLocaleString() : '—'} />
            <Stat label="Delivered" value={run.sentCount.toLocaleString()} tone="success" />
            <Stat label="Failed" value={run.failedCount.toLocaleString()} tone="danger" />
            <Stat label="Skipped" value={run.skippedCount.toLocaleString()} tone="warn" />
            <Stat
              label="Queued"
              value={pending != null ? pending.toLocaleString() : '—'}
              tone="muted"
            />
            <Stat
              label="Success"
              value={successRate != null ? `${successRate}%` : '—'}
            />
          </div>

          {/* Progress */}
          {pct != null && (
            <div className="px-4 pb-3">
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {run.error && (
        <p className="border-y bg-destructive/10 text-destructive px-4 py-2 text-xs break-words">
          {run.error}
        </p>
      )}

      <div className="min-h-0 flex-1 border-t">
        <DeliveryMonitor
          hookId={hookId}
          runId={run.id}
          live={isActive}
          totalRows={total}
          batchSize={run.batchSize}
          endpoint={endpoint}
        />
      </div>
    </div>
  );
}
