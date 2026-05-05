/**
 * useLiveAi — drives the live AI panel during recording.
 *
 * Every `debounceMs` (or whenever a new final segment lands), kicks off a
 * fresh streaming summary using the configured `ISummarizer`. Older
 * generations are aborted so we never render stale TL;DRs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActionItem,
  type Chapter,
  type ISummarizer,
  type SessionSummary,
  type TranscriptionSegment,
  type SummaryLength,
  type SummaryStreamEvent,
} from "@voxnap/core";

export interface LiveAiState {
  tldr: string;
  bullets: string[];
  decisions: string[];
  questions: string[];
  actionItems: ActionItem[];
  chapters: Chapter[];
  status: "idle" | "thinking" | "ready" | "error";
  error: string | null;
  summary: SessionSummary | null;
}

const EMPTY: LiveAiState = {
  tldr: "",
  bullets: [],
  decisions: [],
  questions: [],
  actionItems: [],
  chapters: [],
  status: "idle",
  error: null,
  summary: null,
};

export interface UseLiveAiOptions {
  enabled?: boolean;
  /** Re-run automatically as segments arrive. Default true. */
  auto?: boolean;
  /** Wait this long after the last segment change before regenerating. */
  debounceMs?: number;
  /** Skip summarising until at least N final segments are present. */
  minFinals?: number;
  length?: SummaryLength;
}

export function useLiveAi(
  summarizer: ISummarizer,
  finals: TranscriptionSegment[],
  options: UseLiveAiOptions = {},
) {
  const {
    enabled = true,
    auto = true,
    debounceMs = 1500,
    minFinals = 2,
    length = "medium",
  } = options;

  const [state, setState] = useState<LiveAiState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(EMPTY);
  }, []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((s) => ({
      ...EMPTY,
      // Keep the previous summary visible so the panel doesn't flicker blank.
      tldr: s.tldr,
      bullets: s.bullets,
      decisions: s.decisions,
      questions: s.questions,
      actionItems: s.actionItems,
      chapters: s.chapters,
      status: "thinking",
      error: null,
    }));

    try {
      // We snapshot the next state piece-by-piece.
      const next: LiveAiState = { ...EMPTY, status: "thinking" };
      for await (const ev of summarizer.summariseStream({
        segments: finals,
        length,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        applyEvent(next, ev);
        // Re-emit each tick so the UI sees streaming.
        setState({ ...next });
      }
      next.status = "ready";
      setState({ ...next });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setState((s) => ({ ...s, status: "error", error: String(e) }));
    }
  }, [summarizer, finals, length]);

  // Auto-run on debounce when enabled + new finals arrive.
  useEffect(() => {
    if (!enabled || !auto) return;
    if (finals.length < minFinals) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void run();
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, auto, finals, minFinals, debounceMs, run]);

  // Cancel inflight on unmount or disable.
  useEffect(() => {
    if (!enabled) reset();
    return () => abortRef.current?.abort();
  }, [enabled, reset]);

  return { ...state, run, reset };
}

function applyEvent(next: LiveAiState, ev: SummaryStreamEvent): void {
  switch (ev.type) {
    case "tldr":
      next.tldr = ev.text;
      break;
    case "bullet":
      next.bullets = [...next.bullets, ev.text];
      break;
    case "decision":
      next.decisions = [...next.decisions, ev.text];
      break;
    case "question":
      next.questions = [...next.questions, ev.text];
      break;
    case "actionItem":
      next.actionItems = [...next.actionItems, ev.item];
      break;
    case "chapter":
      next.chapters = [...next.chapters, ev.chapter];
      break;
    case "done":
      next.summary = ev.summary;
      break;
  }
}
