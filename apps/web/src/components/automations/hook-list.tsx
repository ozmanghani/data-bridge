'use client';

import { Plus, Radio, Webhook, Zap } from 'lucide-react';
import type { Hook } from '@relay/core';
import { useHooks } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

function sourceLabel(hook: Hook): string {
  return hook.source.kind === 'table' ? hook.source.table : 'custom query';
}

function destLabel(hook: Hook): string {
  try {
    const { hostname } = new URL(hook.destination.url);
    return `${hook.destination.method} ${hostname}`;
  } catch {
    return hook.destination.method;
  }
}

const TABS = [
  { id: 'hooks' as const, label: 'Hooks', icon: Radio, hint: 'live' },
  { id: 'jobs' as const, label: 'Jobs', icon: Zap, hint: 'on-demand' },
];

export function HookList() {
  const { automationTab, setAutomationTab, selectedHookId, selectHook, openHookEditor } =
    useStudio();
  const { data: hooks, isLoading } = useHooks();

  const isHooks = automationTab === 'hooks';
  const visible =
    hooks?.filter((h) =>
      isHooks ? h.trigger.kind !== 'replay' : h.trigger.kind === 'replay',
    ) ?? [];
  const noun = isHooks ? 'hook' : 'job';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Hooks / Jobs tabs */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setAutomationTab(t.id)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              automationTab === t.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-muted-foreground text-[11px] uppercase tracking-wide">
          {isHooks ? 'Listen & deliver new rows' : 'Send data on demand'}
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
          <p className="text-muted-foreground px-2 py-3 text-sm">Loading…</p>
        )}
        {!isLoading && visible.length === 0 && (
          <div className="text-muted-foreground px-2 py-6 text-center text-sm">
            {isHooks ? (
              <Radio className="mx-auto mb-2 h-6 w-6 opacity-50" />
            ) : (
              <Zap className="mx-auto mb-2 h-6 w-6 opacity-50" />
            )}
            No {noun}s yet.
            <button
              className="text-primary mt-1 block w-full hover:underline"
              onClick={() => openHookEditor()}
            >
              Create your first {noun}
            </button>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {visible.map((hook) => (
            <button
              key={hook.id}
              onClick={() => selectHook(hook.id)}
              className={cn(
                'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                selectedHookId === hook.id ? 'bg-accent' : 'hover:bg-accent/50',
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
              <span className="text-muted-foreground truncate pl-3 font-mono text-xs">
                {sourceLabel(hook)} → {destLabel(hook)}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
