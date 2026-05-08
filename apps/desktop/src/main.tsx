/**
 * Tauri desktop entry.
 *
 * Mounts the shared @voxnap/ui App and injects:
 *   • TauriEngine            — talks to Rust via IPC for ASR
 *   • TauriModelManager      — IPC bridge for model download / list / delete
 *   • HeuristicSummarizer    — multilingual on-device summariser (no network,
 *                              no API key — replaces the old MockSummarizer
 *                              and produces real TR/EN/DE/ES/FR/IT output)
 *   • MemorySessionStore     — localStorage-backed sessions, seeded with demo data
 */
import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import {
  TauriEngine,
  TauriModelManager,
  HeuristicSummarizer,
  MemorySessionStore,
  MOCK_SESSIONS,
} from "@voxnap/core";
import {
  App,
  EngineProvider,
  ModelManagerProvider,
  SummarizerProvider,
  SessionsBootstrap,
  ToastProvider,
} from "@voxnap/ui";

const engine = new TauriEngine();
const modelManager = new TauriModelManager();
const summarizer = new HeuristicSummarizer();
const sessionStore = new MemorySessionStore({ seed: MOCK_SESSIONS });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SummarizerProvider summarizer={summarizer}>
        <SessionsBootstrap store={sessionStore}>
          <EngineProvider engine={engine}>
            <ModelManagerProvider manager={modelManager}>
              {/* Tauri serves over `tauri://localhost` — hash routing avoids 404s. */}
              <App router="hash" />
            </ModelManagerProvider>
          </EngineProvider>
        </SessionsBootstrap>
      </SummarizerProvider>
    </ToastProvider>
  </React.StrictMode>,
);
