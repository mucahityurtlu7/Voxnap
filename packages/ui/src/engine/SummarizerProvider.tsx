/**
 * SummarizerProvider — like EngineProvider, but for the AI summariser.
 *
 * Apps inject either a real LLM client or `MockSummarizer`. Components
 * (live AI panel, session detail) consume via `useSummarizer()`.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ISummarizer } from "@voxnap/core";

const Ctx = createContext<ISummarizer | null>(null);

export interface SummarizerProviderProps {
  summarizer: ISummarizer;
  children: ReactNode;
}

export function SummarizerProvider({ summarizer, children }: SummarizerProviderProps) {
  return <Ctx.Provider value={summarizer}>{children}</Ctx.Provider>;
}

export function useSummarizer(): ISummarizer {
  const s = useContext(Ctx);
  if (!s) {
    throw new Error(
      "useSummarizer() called outside <SummarizerProvider>. Wrap your app with <SummarizerProvider summarizer={…}>.",
    );
  }
  return s;
}
