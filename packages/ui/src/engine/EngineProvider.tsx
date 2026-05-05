/**
 * EngineProvider — supplies the active ITranscriptionEngine to the UI tree.
 *
 * Each app shell (desktop / mobile / web) wraps the UI with this provider
 * and injects the engine appropriate for that platform:
 *
 *   // apps/desktop/src/main.tsx
 *   <EngineProvider engine={new TauriEngine()}><App /></EngineProvider>
 *
 *   // apps/web/src/main.tsx
 *   <EngineProvider engine={new WasmEngine({ workerFactory, modelUrl })}><App /></EngineProvider>
 *
 * Components consume it via `useEngine()` — they never know which engine
 * is behind it. This is the seam that makes Voxnap portable.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ITranscriptionEngine } from "@voxnap/core";

const EngineContext = createContext<ITranscriptionEngine | null>(null);

export interface EngineProviderProps {
  engine: ITranscriptionEngine;
  children: ReactNode;
}

export function EngineProvider({ engine, children }: EngineProviderProps) {
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine(): ITranscriptionEngine {
  const e = useContext(EngineContext);
  if (!e) {
    throw new Error(
      "useEngine() called outside <EngineProvider>. Wrap your app with <EngineProvider engine={…}>.",
    );
  }
  return e;
}
