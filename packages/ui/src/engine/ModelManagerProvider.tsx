/**
 * ModelManagerProvider — supplies the active IModelManager to the UI tree.
 *
 * Each app shell (desktop / mobile / web) wraps the UI with this provider
 * and injects the manager appropriate for that platform:
 *
 *   // apps/desktop/src/main.tsx
 *   <ModelManagerProvider manager={new TauriModelManager()}>
 *     <App />
 *   </ModelManagerProvider>
 *
 * Components consume it via `useModelManager()` — they never know which
 * implementation is behind it. This is the same pattern as
 * `<EngineProvider>`, kept in a separate context so apps can mix and match.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { IModelManager } from "@voxnap/core";

const ModelManagerContext = createContext<IModelManager | null>(null);

export interface ModelManagerProviderProps {
  manager: IModelManager;
  children: ReactNode;
}

export function ModelManagerProvider({ manager, children }: ModelManagerProviderProps) {
  return (
    <ModelManagerContext.Provider value={manager}>
      {children}
    </ModelManagerContext.Provider>
  );
}

export function useModelManager(): IModelManager {
  const m = useContext(ModelManagerContext);
  if (!m) {
    throw new Error(
      "useModelManager() called outside <ModelManagerProvider>. Wrap your app with <ModelManagerProvider manager={…}>.",
    );
  }
  return m;
}

/**
 * Optional variant for components that want to gracefully degrade when no
 * manager has been provided (e.g. early Storybook scenes).
 */
export function useOptionalModelManager(): IModelManager | null {
  return useContext(ModelManagerContext);
}
