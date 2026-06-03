'use client';

import { create } from 'zustand';
import type { RelationKind } from '@relay/core';

export type StudioTab = 'data' | 'query' | 'structure' | 'diagram';

/** Top-level app surface: the database browser vs. the automation tool. */
export type AppMode = 'browse' | 'automations';

export interface SelectedRelation {
  schema?: string;
  table: string;
  kind: RelationKind;
}

/** Prefill payload when opening the hook editor (e.g. from the schema tree). */
export interface HookEditorSeed {
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
}

export interface QueryTab {
  id: string;
  name: string;
  sql: string;
}

let tabSeq = 0;
const nextTabId = () => `qt_${++tabSeq}`;

function freshTabs(): { tabs: QueryTab[]; activeId: string } {
  const id = nextTabId();
  return { tabs: [{ id, name: 'Query 1', sql: '' }], activeId: id };
}

interface StudioState {
  appMode: AppMode;
  activeConnectionId: string | null;
  activeDatabase?: string;
  selected: SelectedRelation | null;
  tab: StudioTab;

  /** Connection editor dialog state. */
  dialog: { open: boolean; editingId: string | null };

  /** Automations surface: the currently selected hook. */
  selectedHookId: string | null;
  /** Hook editor dialog: open + which hook (null = new) + optional prefill. */
  hookEditor: { open: boolean; editingId: string | null; seed: HookEditorSeed | null };

  /** Query editor tabs, lifted here so they survive view switches. */
  queryTabs: QueryTab[];
  activeQueryTabId: string;

  setAppMode: (mode: AppMode) => void;
  setActiveConnection: (id: string | null) => void;
  setActiveDatabase: (db?: string) => void;
  selectRelation: (rel: SelectedRelation) => void;
  setTab: (tab: StudioTab) => void;

  selectHook: (id: string | null) => void;
  openHookEditor: (opts?: { editingId?: string | null; seed?: HookEditorSeed }) => void;
  closeHookEditor: () => void;

  addQueryTab: (opts?: { sql?: string; name?: string }) => void;
  closeQueryTab: (id: string) => void;
  setActiveQueryTab: (id: string) => void;
  updateQueryTabSql: (id: string, sql: string) => void;
  /** Open a statement in a NEW query tab and switch to the Query view. */
  openInQuery: (statement: string, name?: string) => void;

  openConnectionDialog: (editingId?: string | null) => void;
  closeConnectionDialog: () => void;
}

const initial = freshTabs();

export const useStudio = create<StudioState>((set) => ({
  appMode: 'browse',
  activeConnectionId: null,
  activeDatabase: undefined,
  selected: null,
  tab: 'data',
  dialog: { open: false, editingId: null },
  selectedHookId: null,
  hookEditor: { open: false, editingId: null, seed: null },
  queryTabs: initial.tabs,
  activeQueryTabId: initial.activeId,

  setAppMode: (mode) => set({ appMode: mode }),

  selectHook: (id) => set({ selectedHookId: id }),
  openHookEditor: (opts) =>
    set({
      appMode: 'automations',
      hookEditor: {
        open: true,
        editingId: opts?.editingId ?? null,
        seed: opts?.seed ?? null,
      },
    }),
  closeHookEditor: () =>
    set({ hookEditor: { open: false, editingId: null, seed: null } }),

  setActiveConnection: (id) => {
    const f = freshTabs();
    set({
      activeConnectionId: id,
      activeDatabase: undefined,
      selected: null,
      tab: 'data',
      queryTabs: f.tabs,
      activeQueryTabId: f.activeId,
    });
  },
  setActiveDatabase: (db) => set({ activeDatabase: db, selected: null }),
  selectRelation: (rel) => set({ selected: rel, tab: 'data' }),
  setTab: (tab) => set({ tab }),

  addQueryTab: (opts) =>
    set((s) => {
      const id = nextTabId();
      const name = opts?.name ?? `Query ${s.queryTabs.length + 1}`;
      return {
        queryTabs: [...s.queryTabs, { id, name, sql: opts?.sql ?? '' }],
        activeQueryTabId: id,
      };
    }),
  closeQueryTab: (id) =>
    set((s) => {
      if (s.queryTabs.length === 1) {
        const f = freshTabs();
        return { queryTabs: f.tabs, activeQueryTabId: f.activeId };
      }
      const idx = s.queryTabs.findIndex((t) => t.id === id);
      const tabs = s.queryTabs.filter((t) => t.id !== id);
      const activeQueryTabId =
        s.activeQueryTabId === id
          ? (tabs[Math.max(0, idx - 1)]?.id ?? tabs[0]!.id)
          : s.activeQueryTabId;
      return { queryTabs: tabs, activeQueryTabId };
    }),
  setActiveQueryTab: (id) => set({ activeQueryTabId: id }),
  updateQueryTabSql: (id, sql) =>
    set((s) => ({
      queryTabs: s.queryTabs.map((t) => (t.id === id ? { ...t, sql } : t)),
    })),
  openInQuery: (statement, name) =>
    set((s) => {
      const id = nextTabId();
      return {
        queryTabs: [
          ...s.queryTabs,
          { id, name: name ?? `Query ${s.queryTabs.length + 1}`, sql: statement },
        ],
        activeQueryTabId: id,
        tab: 'query',
      };
    }),

  openConnectionDialog: (editingId = null) =>
    set({ dialog: { open: true, editingId } }),
  closeConnectionDialog: () => set({ dialog: { open: false, editingId: null } }),
}));
