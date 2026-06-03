'use client';

import { Loader2, Ban, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { HookRun, HookRunStatus } from '@relay/core';
import { ApiError } from '@/lib/api';
import { useCancelHookRun, useStartHookRun } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DeliveryLog } from './delivery-log';

const STATUS_STYLES: Record<HookRunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  canceling: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  canceled: 'bg-muted text-muted-foreground',
  interrupted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

export function RunStatusBadge({ status }: { status: HookRunStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
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
const RESUMABLE: HookRunStatus[] = ['failed', 'canceled', 'interrupted'];

export function RunDetail({ hookId, run }: { hookId: string; run: HookRun }) {
  const cancel = useCancelHookRun(hookId);
  const resume = useStartHookRun(hookId);

  const isActive = ACTIVE.includes(run.status);
  const total = run.totalCount;
  const done = run.sentCount + run.failedCount;
  const pct = total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

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
      await resume.mutateAsync(run.id);
      toast.success('Run resumed');
    } catch (err) {
      toast.error('Could not resume', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <RunStatusBadge status={run.status} />
        <div className="flex items-center gap-4 text-sm">
          <span>
            <span className="font-medium text-emerald-600">{run.sentCount}</span>{' '}
            <span className="text-muted-foreground">sent</span>
          </span>
          <span>
            <span className="font-medium text-destructive">{run.failedCount}</span>{' '}
            <span className="text-muted-foreground">failed</span>
          </span>
          <span className="text-muted-foreground">
            {total != null ? `of ${total}` : 'of ?'}
          </span>
          {pct != null && (
            <span className="text-muted-foreground">· {pct}%</span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isActive && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancel}
              disabled={cancel.isPending}
            >
              <Ban className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
          {RESUMABLE.includes(run.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleResume}
              disabled={resume.isPending}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          )}
        </div>
      </div>

      {pct != null && (
        <div className="h-1 w-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {run.error && (
        <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {run.error}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <DeliveryLog hookId={hookId} runId={run.id} live={isActive} />
      </div>
    </div>
  );
}
