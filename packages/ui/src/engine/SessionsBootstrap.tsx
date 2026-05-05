/**
 * Boot helper that attaches the persistence backend to the global sessions
 * store on first mount. Apps render it once near the root.
 */
import { useEffect, type ReactNode } from "react";
import { useSessionsStore, type ISessionStore } from "@voxnap/core";

export interface SessionsBootstrapProps {
  store: ISessionStore;
  children?: ReactNode;
}

export function SessionsBootstrap({ store, children }: SessionsBootstrapProps) {
  useEffect(() => {
    useSessionsStore.getState().attach(store);
  }, [store]);
  return <>{children}</>;
}
