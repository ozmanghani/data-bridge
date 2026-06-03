'use client';

import {
  Database,
  LayoutGrid,
  Network,
  Table2,
  TerminalSquare,
  Webhook,
} from 'lucide-react';
import { useConnections } from '@/lib/queries';
import { useStudio, type AppMode, type StudioTab } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { ConnectionList } from '@/components/connections/connection-list';
import { ConnectionDialog } from '@/components/connections/connection-dialog';
import { SchemaTree } from '@/components/schema/schema-tree';
import { DataGrid } from '@/components/data/data-grid';
import { QueryEditor } from '@/components/query/query-editor';
import { StructureView } from '@/components/structure/structure-view';
import { ERDiagram } from '@/components/diagram/er-diagram';
import { AutomationsView } from '@/components/automations/automations-view';
import { HookList } from '@/components/automations/hook-list';
import { HookEditor } from '@/components/automations/hook-editor';

const TABS: { id: StudioTab; label: string; icon: typeof Table2 }[] = [
  { id: 'data', label: 'Data', icon: LayoutGrid },
  { id: 'structure', label: 'Structure', icon: Table2 },
  { id: 'query', label: 'Query', icon: TerminalSquare },
  { id: 'diagram', label: 'Diagram', icon: Network },
];

const MODES: { id: AppMode; label: string; icon: typeof Database }[] = [
  { id: 'browse', label: 'Browse', icon: Database },
  { id: 'automations', label: 'Automations', icon: Webhook },
];

export function Studio() {
  const { appMode, setAppMode, activeConnectionId, activeDatabase, selected, tab, setTab } =
    useStudio();
  const { data: connections } = useConnections();
  const conn = connections?.find((c) => c.id === activeConnectionId);

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-screen">
        {/* Sidebar */}
        <ResizablePanel defaultSize={20} minSize={14} maxSize={32}>
          <div className="flex h-full flex-col border-r">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Webhook className="h-5 w-5 text-primary" />
                <span className="font-semibold tracking-tight">Relay</span>
              </div>
              <ThemeToggle />
            </div>

            {/* Mode switch */}
            <div className="grid grid-cols-2 gap-1 px-2 pb-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setAppMode(m.id)}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
                    appMode === m.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  <m.icon className="h-3.5 w-3.5" />
                  {m.label}
                </button>
              ))}
            </div>
            <Separator />

            {appMode === 'browse' ? (
              <>
                <ConnectionList />
                <Separator className="my-1" />
                <SchemaTree />
              </>
            ) : (
              <HookList />
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Main */}
        <ResizablePanel defaultSize={80}>
          {appMode === 'automations' ? (
            <AutomationsView />
          ) : (
            <div className="flex h-full flex-col">
              {/* Breadcrumb + tabs */}
              <div className="flex items-center gap-1 border-b px-3">
                <div className="flex h-11 items-center gap-1.5 pr-3 text-sm text-muted-foreground">
                  {conn ? (
                    <>
                      <span className="font-medium text-foreground">{conn.name}</span>
                      {activeDatabase && (
                        <>
                          <span>/</span>
                          <span>{activeDatabase}</span>
                        </>
                      )}
                      {selected && (
                        <>
                          <span>/</span>
                          <span className="font-mono text-foreground">
                            {selected.table}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span>No connection selected</span>
                  )}
                </div>

                <div className="ml-auto flex items-center">
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={cn(
                        'flex h-11 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors',
                        tab === t.id
                          ? 'border-primary text-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <t.icon className="h-4 w-4" />
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tab content */}
              <div className="min-h-0 flex-1">
                {tab === 'data' && <DataGrid />}
                {tab === 'structure' && <StructureView />}
                {tab === 'query' && <QueryEditor />}
                {tab === 'diagram' && <ERDiagram />}
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionDialog />
      <HookEditor />
    </>
  );
}
