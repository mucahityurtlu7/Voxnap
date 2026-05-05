/**
 * MockSummarizer — deterministic, network-free fake LLM.
 *
 * Used by `apps/web` in dev and by every test/UI playground. It mimics
 * the streaming feel of a real model so the UI's skeletons, typewriter
 * effects and abort handling can be exercised without an API key.
 */
import { nanoid } from "nanoid";

import type {
  ActionItem,
  Chapter,
  Sentiment,
  SessionSummary,
} from "../types.js";
import type {
  ISummarizer,
  SummariseRequest,
  SummaryStreamEvent,
} from "./ISummarizer.js";

export interface MockSummarizerOptions {
  /** Per-event delay in ms (lower = snappier). Default 220ms. */
  tickMs?: number;
  /** If true, occasionally add a "thinking" pause to feel more lifelike. */
  jitter?: boolean;
  /** Provider label that lands in `summary.generatedBy`. */
  label?: string;
}

const DEFAULTS: Required<MockSummarizerOptions> = {
  tickMs: 220,
  jitter: true,
  label: "Voxnap Mock · gpt-pretend-4",
};

/**
 * Heuristic that turns a flat transcript into mock structured output.
 * It's intentionally simple — the goal is *plausible*, not accurate.
 */
function deriveSummary(text: string, length: "short" | "medium" | "long" = "medium") {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const head = sentences.slice(0, 12);
  const target = length === "short" ? 3 : length === "long" ? 7 : 5;

  const bullets = head.slice(0, target).map((s) =>
    s.length > 140 ? s.slice(0, 137).trim() + "…" : s,
  );

  const tldr =
    head[0] && head[0].length > 12
      ? head[0].replace(/\.$/, "")
      : "A short conversation captured by Voxnap.";

  const decisions: string[] = [];
  const questions: string[] = [];
  for (const s of head) {
    if (/\?$/.test(s) && questions.length < 3) questions.push(s);
    else if (/\b(decid|agree|will|let'?s|going to|plan to)\b/i.test(s) && decisions.length < 3) {
      decisions.push(s);
    }
  }

  const sentiment: Sentiment = /\b(great|love|awesome|excited|nice)\b/i.test(text)
    ? "positive"
    : /\b(bad|issue|problem|bug|sorry|fail)\b/i.test(text)
      ? "negative"
      : "neutral";

  return { tldr, bullets, decisions, questions, sentiment };
}

function deriveActionItems(text: string): ActionItem[] {
  const out: ActionItem[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (out.length >= 4) break;
    if (/\b(todo|action|follow ?up|will|need to|let'?s|please|should)\b/i.test(s)) {
      out.push({
        id: nanoid(8),
        text: s.length > 160 ? s.slice(0, 157).trim() + "…" : s.trim(),
        done: false,
      });
    }
  }
  return out;
}

function deriveChapters(text: string, durationMs: number): Chapter[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length);
  if (sentences.length === 0) return [];
  const chunks = Math.min(4, Math.max(2, Math.ceil(sentences.length / 6)));
  const per = Math.max(1, Math.floor(sentences.length / chunks));
  const chapters: Chapter[] = [];
  for (let i = 0; i < chunks; i++) {
    const slice = sentences.slice(i * per, i === chunks - 1 ? undefined : (i + 1) * per);
    if (slice.length === 0) continue;
    const title = (slice[0] ?? "").split(" ").slice(0, 5).join(" ").replace(/[.,;]$/, "");
    chapters.push({
      id: nanoid(8),
      title: title || `Chapter ${i + 1}`,
      startMs: Math.floor((i / chunks) * durationMs),
      endMs: Math.floor(((i + 1) / chunks) * durationMs),
      summary: slice.slice(0, 2).join(" "),
    });
  }
  return chapters;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

export class MockSummarizer implements ISummarizer {
  private readonly opts: Required<MockSummarizerOptions>;

  constructor(opts: MockSummarizerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  async summarise(req: SummariseRequest): Promise<SessionSummary> {
    let last: SessionSummary | null = null;
    for await (const ev of this.summariseStream(req)) {
      if (ev.type === "done") last = ev.summary;
    }
    if (!last) {
      // Empty transcript — synthesise an empty-but-valid summary.
      last = {
        tldr: "Nothing was said.",
        bullets: [],
        decisions: [],
        questions: [],
        sentiment: "neutral",
        generatedAt: new Date().toISOString(),
        generatedBy: this.opts.label,
      };
    }
    return last;
  }

  async *summariseStream(req: SummariseRequest): AsyncIterable<SummaryStreamEvent> {
    const text = req.segments
      .filter((s) => s.isFinal)
      .map((s) => s.text)
      .join(" ")
      .trim();

    const { tldr, bullets, decisions, questions, sentiment } = deriveSummary(
      text,
      req.length ?? "medium",
    );

    const tick = async () => {
      await sleep(this.opts.tickMs + (this.opts.jitter ? Math.random() * 120 : 0), req.signal);
    };

    // Initial "thinking" delay so the UI can show its skeleton.
    await tick();

    yield { type: "tldr", text: tldr };
    for (const b of bullets) {
      await tick();
      yield { type: "bullet", text: b };
    }
    for (const d of decisions) {
      await tick();
      yield { type: "decision", text: d };
    }
    for (const q of questions) {
      await tick();
      yield { type: "question", text: q };
    }

    // Action items (mock heuristic)
    for (const item of deriveActionItems(text)) {
      await tick();
      yield { type: "actionItem", item };
    }

    // Chapters
    const lastSeg = req.segments[req.segments.length - 1];
    const duration = lastSeg ? lastSeg.endMs : 0;
    for (const ch of deriveChapters(text, duration)) {
      await tick();
      yield { type: "chapter", chapter: ch };
    }

    const summary: SessionSummary = {
      tldr,
      bullets,
      decisions,
      questions,
      sentiment,
      generatedAt: new Date().toISOString(),
      generatedBy: this.opts.label,
    };
    await tick();
    yield { type: "done", summary };
  }

  async suggestTitle({
    segments,
  }: {
    segments: { text: string; isFinal: boolean }[];
    language: string;
  }): Promise<string> {
    const first = segments.find((s) => s.isFinal && s.text.trim().length > 0);
    if (!first) return "Untitled session";
    const words = first.text.split(/\s+/).slice(0, 6).join(" ");
    return words.replace(/[.,;:!?]+$/, "") || "Untitled session";
  }
}
