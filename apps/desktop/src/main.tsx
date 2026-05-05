/**
 * Tauri desktop entry.
 *
 * Mounts the shared @voxnap/ui App and injects:
 *   • TauriEngine            — talks to Rust via IPC for ASR
 *   • MockSummarizer         — placeholder until we ship a real LLM bridge
 *   • MemorySessionStore     — localStorage-backed sessions, seeded with demo data
 */
import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import {
  TauriEngine,
  MockSummarizer,
  MemorySessionStore,
  MOCK_SESSIONS,
} from "@voxnap/core";
import {
  App,
  EngineProvider,
  SummarizerProvider,
  SessionsBootstrap,
  ToastProvider,
} from "@voxnap/ui";

const engine = new TauriEngine();
const summarizer = new MockSummarizer();
const sessionStore = new MemorySessionStore({ seed: MOCK_SESSIONS });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SummarizerProvider summarizer={summarizer}>
        <SessionsBootstrap store={sessionStore}>
          <EngineProvider engine={engine}>
            {/* Tauri serves over `tauri://localhost` — hash routing avoids 404s. */}
            <App router="hash" />
          </EngineProvider>
        </SessionsBootstrap>
      </SummarizerProvider>
    </ToastProvider>
  </React.StrictMode>,
);
