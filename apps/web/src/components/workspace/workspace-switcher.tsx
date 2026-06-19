'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown, Plus, Trash2, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  useWorkspaces,
  useCreateWorkspace,
  useDeleteWorkspace,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { DEFAULT_WORKSPACE_ID } from '@data-bridge/core';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function WorkspaceSwitcher() {
  const { data: workspaces } = useWorkspaces();
  const activeWorkspaceId = useStudio((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStudio((s) => s.setActiveWorkspace);
  const create = useCreateWorkspace();
  const del = useDeleteWorkspace();

  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // once workspaces load, make sure something is selected. prefer keeping the
  // current one; otherwise fall back to the default, then the first.
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    const stillThere = workspaces.some((w) => w.id === activeWorkspaceId);
    if (!stillThere) {
      const fallback =
        workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID) ?? workspaces[0];
      if (fallback) setActiveWorkspace(fallback.id);
    }
  }, [workspaces, activeWorkspaceId, setActiveWorkspace]);

  const active = workspaces?.find((w) => w.id === activeWorkspaceId) ?? null;

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const ws = await create.mutateAsync({ name: trimmed });
      setActiveWorkspace(ws.id);
      setNewOpen(false);
      setName('');
      toast.success(`Workspace "${ws.name}" created`);
    } catch (err) {
      toast.error('Could not create workspace', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDelete() {
    if (!active) return;
    try {
      await del.mutateAsync(active.id);
      toast.success(`Workspace "${active.name}" deleted`);
      setConfirmDelete(false);
    } catch (err) {
      toast.error('Could not delete workspace', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-[150px] gap-1.5 px-2"
            title="Switch workspace"
          >
            <Layers className="text-primary h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-sm font-medium">
              {active?.name ?? 'Workspace'}
            </span>
            <ChevronsUpDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-muted-foreground text-[11px] uppercase tracking-wide">
            Workspaces
          </DropdownMenuLabel>
          {workspaces?.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onClick={() => setActiveWorkspace(w.id)}
              className="gap-2"
            >
              <Check
                className={cn(
                  'h-4 w-4',
                  w.id === activeWorkspaceId ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className="truncate">{w.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNewOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New workspace
          </DropdownMenuItem>
          {active && active.id !== DEFAULT_WORKSPACE_ID && (
            <DropdownMenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-destructive focus:text-destructive gap-2"
            >
              <Trash2 className="h-4 w-4" /> Delete “{active.name}”
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* New workspace dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="e.g. Production, Acme Corp, Staging"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              “{active?.name}” and all of its connections and bridges will be
              permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
