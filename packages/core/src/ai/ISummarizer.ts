/**
 * Summariser abstraction.
 *
 * UI never imports a concrete summariser — it goes through this contract,
 * the same way it goes through ITranscriptionEngine for ASR.
 *
 * The streaming variant emits partial summaries so the UI can show a
 * "thinking…" state with progressively filled bullets.
 */
import type {
  ActionItem,
  Chapter,
  Session,
  SessionSummary,
  SummaryLength,
  TranscriptionSegment,
} from "../types.js";

export interface SummariseRequest {
  /** Text the model should summarise. Either a finished session or a live tail. */
  segments: TranscriptionSegment[];
  /** Hint about how long the result should be. */
  length?: SummaryLength;
  /** ISO 639-1 of the desired summary output. Defaults to source language. */
  outputLanguage?: string;
  /** Free-form additional instructions (e.g. "focus on action items"). */
  systemPrompt?: string;
  /** Pass to abort an in-flight streaming generation. */
  signal?: AbortSignal;
}

/**
 * Streaming events emitted while a summary is being produced.
 *
 * The UI typically subscribes once and renders whatever fields have arrived.
 */
export type SummaryStreamEvent =
  | { type: "tldr"; text: string }
  | { type: "bullet"; text: string }
  | { type: "decision"; text: string }
  | { type: "question"; text: string }
  | { type: "actionItem"; item: ActionItem }
  | { type: "chapter"; chapter: Chapter }
  | { type: "done"; summary: SessionSummary };

export interface ISummarizer {
  /** Produce a one-shot summary; resolves once everything is filled in. */
  summarise(req: SummariseRequest): Promise<SessionSummary>;

  /**
   * Stream a summary, yielding partial events the UI can render incrementally.
   * Implementations may translate a single LLM call into many micro-events.
   */
  summariseStream(req: SummariseRequest): AsyncIterable<SummaryStreamEvent>;

  /**
   * Suggest a short, human-friendly title for the session (e.g. for a sidebar).
   * Optional — the mock engine fills this with a couple of leading words.
   */
  suggestTitle?(session: Pick<Session, "segments" | "language">): Promise<string>;
}
