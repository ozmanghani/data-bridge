'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BrowseParams,
  ConnectionInputDTO,
  HookInputDTO,
  HookRun,
  WorkspaceInputDTO,
} from '@data-bridge/core';
import { api } from './api';
import { useStudio } from './store';

export const queryKeys = {
  drivers: ['drivers'] as const,
  workspaces: ['workspaces'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
  databases: (id: string) => ['connections', id, 'databases'] as const,
  schema: (id: string, database?: string) =>
    ['connections', id, 'schema', database ?? 'default'] as const,
  browse: (id: string, database: string | undefined, params: BrowseParams) =>
    ['connections', id, 'browse', database ?? 'default', params] as const,
  hooks: ['hooks'] as const,
  hook: (id: string) => ['hooks', id] as const,
  hookRuns: (id: string) => ['hooks', id, 'runs'] as const,
  hookRun: (id: string, runId: string) => ['hooks', id, 'runs', runId] as const,
  hookDeliveries: (id: string, runId: string) =>
    ['hooks', id, 'runs', runId, 'deliveries'] as const,
};

export function useDrivers() {
  return useQuery({
    queryKey: queryKeys.drivers,
    queryFn: () => api.listDrivers(),
    staleTime: Infinity,
  });
}

/* ----- workspaces ----- */

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.listWorkspaces(),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkspaceInputDTO) => api.createWorkspace(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WorkspaceInputDTO }) =>
      api.updateWorkspace(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: () => {
      // a workspace delete cascades to its connections + hooks
      qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      qc.invalidateQueries({ queryKey: queryKeys.connections });
      qc.invalidateQueries({ queryKey: queryKeys.hooks });
    },
  });
}

/** connections in the active workspace (the key carries the id so it refetches) */
export function useConnections() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: [...queryKeys.connections, workspaceId],
    queryFn: () => api.listConnections(workspaceId ?? undefined),
    enabled: !!workspaceId,
  });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useMutation({
    // stamp the active workspace so new connections land where the user is
    mutationFn: (input: ConnectionInputDTO) =>
      api.createConnection({ ...input, workspaceId: input.workspaceId ?? workspaceId ?? undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ConnectionInputDTO }) =>
      api.updateConnection(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useSchema(id: string | null, database?: string) {
  return useQuery({
    queryKey: id ? queryKeys.schema(id, database) : ['schema', 'none'],
    queryFn: () => api.getSchema(id as string, database),
    enabled: !!id,
  });
}

export function useDatabases(id: string | null) {
  return useQuery({
    queryKey: id ? queryKeys.databases(id) : ['databases', 'none'],
    queryFn: () => api.listDatabases(id as string),
    enabled: !!id,
  });
}

export function useBrowse(
  id: string | null,
  params: BrowseParams | null,
  database?: string,
) {
  return useQuery({
    queryKey:
      id && params
        ? queryKeys.browse(id, database, params)
        : ['browse', 'none'],
    queryFn: () => api.browse(id as string, params as BrowseParams, database),
    enabled: !!id && !!params,
    placeholderData: (prev) => prev,
  });
}

/* ----- automation hooks ----- */

/** bridges (hooks) in the active workspace */
export function useHooks() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: [...queryKeys.hooks, workspaceId],
    queryFn: () => api.listHooks(workspaceId ?? undefined),
    enabled: !!workspaceId,
  });
}

/** latest run status per bridge — polled so the map colors stay live */
export function useHookStatuses() {
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useQuery({
    queryKey: ['hookStatuses', workspaceId],
    queryFn: () => api.listHookStatuses(workspaceId as string),
    enabled: !!workspaceId,
    refetchInterval: 3000,
  });
}

export function useCreateHook() {
  const qc = useQueryClient();
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  return useMutation({
    // stamp the active workspace so a new bridge belongs to the current one
    mutationFn: (input: HookInputDTO) =>
      api.createHook({ ...input, workspaceId: input.workspaceId ?? workspaceId ?? undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.hooks }),
  });
}

export function useUpdateHook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: HookInputDTO }) =>
      api.updateHook(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.hooks }),
  });
}

export function useDeleteHook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteHook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.hooks }),
  });
}

export function useStartHookRun(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      opts: {
        resumeRunId?: string;
        runId?: string;
        retryFailedOf?: string;
      } = {},
    ) => api.startHookRun(hookId, opts),
    // also refresh statuses so the map node/edge updates instantly, not on the poll
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useStartWatch(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startWatch(hookId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useStopWatch(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopWatch(hookId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useRetryFailed(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.retryFailedDeliveries(hookId, runId),
    onSuccess: (_d, runId) => {
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({
        queryKey: queryKeys.hookDeliveries(hookId, runId),
      });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

export function useCancelHookRun(hookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelHookRun(hookId, runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
      qc.invalidateQueries({ queryKey: ['hookStatuses'] });
    },
  });
}

/** live-polls while any run is still active */
export function useHookRuns(hookId: string | null) {
  return useQuery({
    queryKey: hookId ? queryKeys.hookRuns(hookId) : ['hookRuns', 'none'],
    queryFn: () => api.listHookRuns(hookId as string),
    enabled: !!hookId,
    refetchInterval: (query) => {
      const runs = query.state.data as HookRun[] | undefined;
      const active = runs?.some((r) =>
        ['queued', 'running', 'canceling'].includes(r.status),
      );
      return active ? 1500 : false;
    },
  });
}

export function useHookDeliveries(
  hookId: string | null,
  runId: string | null,
  live: boolean,
  opts: {
    status?: 'success' | 'failed' | 'skipped';
    from?: number;
    to?: number;
  } = {},
) {
  const qc = useQueryClient();
  const prevLiveRef = useRef(live);

  const query = useQuery({
    queryKey:
      hookId && runId
        ? [...queryKeys.hookDeliveries(hookId, runId), opts]
        : ['hookDeliveries', 'none'],
    queryFn: () =>
      api.listHookDeliveries(hookId as string, runId as string, {
        ...opts,
        limit: 2000,
      }),
    enabled: !!hookId && !!runId,
    refetchInterval: live ? 1500 : false,
    staleTime: 0,
  });

  const { refetch } = query;

  // when a run goes from active to terminal, fire one final refetch so
  // deliveries written between the last poll and completion show up.
  // also invalidate sibling windows so navigating to another page is fresh
  useEffect(() => {
    if (prevLiveRef.current && !live && hookId && runId) {
      void refetch();
      void qc.invalidateQueries({
        queryKey: queryKeys.hookDeliveries(hookId, runId),
      });
    }
    prevLiveRef.current = live;
  }, [live, hookId, runId, refetch, qc]);

  return query;
}

export function useSkipDeliveries(hookId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sequences: number[]) =>
      api.skipHookRun(hookId, runId, sequences),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.hookDeliveries(hookId, runId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.hookRuns(hookId) });
    },
  });
}
