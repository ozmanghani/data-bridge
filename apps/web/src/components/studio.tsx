'use client';

import { useEffect } from 'react';
import { Database, Webhook } from 'lucide-react';
import { useStudio } from '@/lib/store';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { ConnectionDialog } from '@/components/connections/connection-dialog';
import { AutomationsView } from '@/components/automations/automations-view';
import { HookList } from '@/components/automations/hook-list';
import { HookBuilder } from '@/components/automations/hook-builder';
import { DataSourcesManager } from '@/components/data-sources-manager';

/**
 * The app is a hooks workspace. The sidebar lists hooks; the main panel shows
 * the selected hook's runs. Connecting to a database, browsing tables and DDL
 * live in the Data Sources surface and the Hook Builder — the data source
 * exists to feed hooks.
 */
export function Studio() {
  const {
    selectedHookId,
    selectHook,
    dataSourcesOpen,
    openDataSources,
    hookEditor,
    openHookEditor,
  } = useStudio();

  // Restore UI state from the URL on load, and keep the URL in sync — so a
  // refresh keeps you on the same hook / surface instead of bouncing to root.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const hook = p.get('hook');
    if (hook) selectHook(hook);
    if (p.get('data') === '1') openDataSources();
    const edit = p.get('edit');
    if (edit) openHookEditor({ editingId: edit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = new URLSearchParams();
    if (selectedHookId) p.set('hook', selectedHookId);
    if (dataSourcesOpen) p.set('data', '1');
    if (hookEditor.open && hookEditor.editingId) p.set('edit', hookEditor.editingId);
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [selectedHookId, dataSourcesOpen, hookEditor.open, hookEditor.editingId]);

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-screen">
        {/* Sidebar — hooks only */}
        <ResizablePanel defaultSize={22} minSize={16} maxSize={32}>
          <div className="flex h-full flex-col border-r">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Webhook className="text-primary h-5 w-5" />
                <span className="font-semibold tracking-tight">Relay</span>
                <span className="text-muted-foreground text-xs">Hooks</span>
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title="Data sources"
                  onClick={openDataSources}
                >
                  <Database className="h-4 w-4" />
                </Button>
                <ThemeToggle />
              </div>
            </div>
            <Separator />
            <HookList />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Main — the hooks workspace */}
        <ResizablePanel defaultSize={78}>
          <AutomationsView />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionDialog />
      <HookBuilder />
      <DataSourcesManager />
    </>
  );
}
