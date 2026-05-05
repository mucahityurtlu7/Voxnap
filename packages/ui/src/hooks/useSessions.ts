/**
 * useSessions — convenience hook that exposes the global sessions store.
 *
 * Apps wire the persistence backend once on boot (see `<EngineProvider>`
 * in their main.tsx) by calling `useSessionsStore.getState().attach(store)`.
 * Components then just call this hook.
 */
import { useSessionsStore } from "@voxnap/core";
import type { Session } from "@voxnap/core";

export function useSessions() {
  const sessions = useSessionsStore((s) => s.sessions);
  const loading = useSessionsStore((s) => s.loading);
  const loaded = useSessionsStore((s) => s.loaded);
  const upsert = useSessionsStore((s) => s.upsert);
  const remove = useSessionsStore((s) => s.remove);
  const setSummary = useSessionsStore((s) => s.setSummary);
  const setActionItems = useSessionsStore((s) => s.setActionItems);
  const toggleStar = useSessionsStore((s) => s.toggleStar);
  const rename = useSessionsStore((s) => s.rename);
  const reload = useSessionsStore((s) => s.reload);
  return {
    sessions,
    loading,
    loaded,
    upsert,
    remove,
    setSummary,
    setActionItems,
    toggleStar,
    rename,
    reload,
  };
}

export function useSession(id: string | undefined): Session | undefined {
  return useSessionsStore((s) =>
    id ? s.sessions.find((x) => x.id === id) : undefined,
  );
}
