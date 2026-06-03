'use client';

import { Plus, Webhook } from 'lucide-react';
import type { Hook } from '@relay/core';
import { useHooks } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

function sourceLabel(hook: Hook): string {
  return hook.source.kind === 'table'
    ? hook.source.table
    : 'custom query';
}

export function HookList() {
  const { selectedHookId, selectHook, openHookEditor } = useStudio();
  const { data: hooks, isLoading } = useHooks();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Automations
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => openHookEditor()}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        {isLoading && (
          <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>
        )}
        {!isLoading && (hooks?.length ?? 0) === 0 && (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            <Webhook className="mx-auto mb-2 h-6 w-6 opacity-50" />
            No hooks yet.
            <button
              className="mt-1 block w-full text-primary hover:underline"
              onClick={() => openHookEditor()}
            >
              Create your first hook
            </button>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {hooks?.map((hook) => (
            <button
              key={hook.id}
              onClick={() => selectHook(hook.id)}
              className={cn(
                'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                selectedHookId === hook.id
                  ? 'bg-accent'
                  : 'hover:bg-accent/50',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    hook.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                  )}
                />
                <span className="truncate text-sm font-medium">{hook.name}</span>
              </div>
              <span className="truncate pl-3 font-mono text-xs text-muted-foreground">
                {sourceLabel(hook)} → {hook.destination.method}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
