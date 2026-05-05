/**
 * Tauri mobile entry. Uses the same shared App + TauriEngine as desktop.
 * The Rust backend in `src-tauri` re-exports the desktop crate, so the IPC
 * surface is identical across platforms.
 */
import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import {
  MemorySessionStore,
  MOCK_SESSIONS,
  MockSummarizer,
  TauriEngine,
} from "@voxnap/core";
import {
  App,
  EngineProvider,
  SessionsBootstrap,
  SummarizerProvider,
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
            <App router="hash" />
          </EngineProvider>
        </SessionsBootstrap>
      </SummarizerProvider>
    </ToastProvider>
  </React.StrictMode>,
);
