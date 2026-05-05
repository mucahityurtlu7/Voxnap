/**
 * AI preferences store.
 *
 * Holds provider selection, summary length, "auto-summarise on stop"
 * toggle, etc. Persisted to localStorage where available.
 */
import { create } from "zustand";

import type { AiProvider, SummaryLength } from "../types.js";

export interface AiPreferences {
  provider: AiProvider;
  /** API key string — only stored when provider needs one. UI-only mock. */
  apiKey: string;
  summaryLength: SummaryLength;
  autoSummarise: boolean;
  /** When true, generate live TL;DR/bullets while recording. */
  liveAi: boolean;
}

const DEFAULTS: AiPreferences = {
  provider: "mock",
  apiKey: "",
  summaryLength: "medium",
  autoSummarise: true,
  liveAi: true,
};

const STORAGE_KEY = "voxnap.ai.v1";

function readPrefs(): AiPreferences {
  if (typeof globalThis === "undefined") return DEFAULTS;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return DEFAULTS;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AiPreferences>) };
  } catch {
    return DEFAULTS;
  }
}

function writePrefs(prefs: AiPreferences): void {
  if (typeof globalThis === "undefined") return;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export interface AiState extends AiPreferences {
  setProvider: (p: AiProvider) => void;
  setApiKey: (key: string) => void;
  setSummaryLength: (l: SummaryLength) => void;
  setAutoSummarise: (v: boolean) => void;
  setLiveAi: (v: boolean) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  ...readPrefs(),
  setProvider: (provider) => {
    set({ provider });
    writePrefs({ ...get(), provider });
  },
  setApiKey: (apiKey) => {
    set({ apiKey });
    writePrefs({ ...get(), apiKey });
  },
  setSummaryLength: (summaryLength) => {
    set({ summaryLength });
    writePrefs({ ...get(), summaryLength });
  },
  setAutoSummarise: (autoSummarise) => {
    set({ autoSummarise });
    writePrefs({ ...get(), autoSummarise });
  },
  setLiveAi: (liveAi) => {
    set({ liveAi });
    writePrefs({ ...get(), liveAi });
  },
}));
