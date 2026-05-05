/**
 * Sessions store — keeps the session list in memory for the UI.
 *
 * The store is a thin reactive cache around an injected ISessionStore.
 * UI calls actions, the store updates the cache + delegates persistence.
 */
import { create } from "zustand";

import type { ActionItem, Session, SessionSummary } from "../types.js";
import type { ISessionStore } from "../sessions/ISessionStore.js";

export interface SessionsState {
  sessions: Session[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  /** Inject the persistence backend (called once on app boot). */
  attach: (store: ISessionStore) => void;
  reload: () => Promise<void>;
  upsert: (session: Session) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setSummary: (id: string, summary: SessionSummary) => Promise<void>;
  setActionItems: (id: string, items: ActionItem[]) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set, get) => {
  let backing: ISessionStore | null = null;

  const requireStore = (): ISessionStore => {
    if (!backing) {
      throw new Error(
        "useSessionsStore: no ISessionStore attached yet. Call attach(store) on app boot.",
      );
    }
    return backing;
  };

  return {
    sessions: [],
    loaded: false,
    loading: false,
    error: null,

    attach: (store) => {
      backing = store;
      void get().reload();
    },

    reload: async () => {
      const store = requireStore();
      set({ loading: true, error: null });
      try {
        const sessions = await store.list();
        set({ sessions, loaded: true, loading: false });
      } catch (e) {
        set({ loading: false, error: String(e) });
      }
    },

    upsert: async (session) => {
      const store = requireStore();
      await store.save(session);
      const idx = get().sessions.findIndex((s) => s.id === session.id);
      const next =
        idx >= 0
          ? get().sessions.map((s) => (s.id === session.id ? session : s))
          : [session, ...get().sessions];
      set({ sessions: next });
    },

    remove: async (id) => {
      const store = requireStore();
      await store.delete(id);
      set({ sessions: get().sessions.filter((s) => s.id !== id) });
    },

    setSummary: async (id, summary) => {
      const store = requireStore();
      await store.setSummary(id, summary);
      set({
        sessions: get().sessions.map((s) =>
          s.id === id ? { ...s, summary } : s,
        ),
      });
    },

    setActionItems: async (id, items) => {
      const store = requireStore();
      await store.setActionItems(id, items);
      set({
        sessions: get().sessions.map((s) =>
          s.id === id ? { ...s, actionItems: items } : s,
        ),
      });
    },

    toggleStar: async (id) => {
      const store = requireStore();
      const current = get().sessions.find((s) => s.id === id);
      if (!current) return;
      const starred = !current.starred;
      await store.setStarred(id, starred);
      set({
        sessions: get().sessions.map((s) =>
          s.id === id ? { ...s, starred } : s,
        ),
      });
    },

    rename: async (id, title) => {
      const store = requireStore();
      await store.rename(id, title);
      set({
        sessions: get().sessions.map((s) =>
          s.id === id ? { ...s, title } : s,
        ),
      });
    },
  };
});

export function selectSession(id: string | undefined) {
  return (state: SessionsState): Session | undefined =>
    id ? state.sessions.find((s) => s.id === id) : undefined;
}
