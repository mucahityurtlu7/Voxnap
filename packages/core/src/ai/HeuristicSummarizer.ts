/**
 * HeuristicSummarizer — on-device, zero-network summary generator.
 *
 * Successor to `MockSummarizer`. Same `ISummarizer` contract, same
 * streaming feel, but the actual content is *useful* in any of the
 * supported languages (en, tr, de, es, fr, it) instead of leaking
 * scripted English placeholders into Turkish UIs.
 *
 * Pipeline
 * --------
 * 1. **Detect language** off the transcript (Unicode-aware, biased to
 *    Turkish when diacritics are present — see `stopwords.ts`).
 * 2. **Sentence segment** with abbreviation awareness so "Dr. Yılmaz"
 *    doesn't split mid-name and Turkish exclamations don't get glued
 *    together by the naive `/(?<=[.!?])\s+/` pattern.
 * 3. **Score keywords** with a TF-IDF-ish weight:
 *    `tf · log(1 + N_sentences / df)` over non-stopword tokens.
 * 4. **Score sentences** by averaging keyword weights of their content
 *    words, with bonuses for "early in transcript" position and a
 *    light-handed length penalty on extremes.
 * 5. **Pick TL;DR** = highest-scoring sentence among the first 30%
 *    (lead bias — meetings front-load context). Filler-stripped.
 * 6. **Pick bullets** = top-N sentences by score with MMR-style
 *    diversity (drop candidates that share ≥40% keywords with one
 *    already selected) so the bullet list isn't three rephrasings of
 *    the same idea.
 * 7. **Buckets** (decisions / questions / actions / sentiment) are
 *    classified per sentence using the language lexicon.
 * 8. **Chapters** are emitted on topic-shift boundaries detected via
 *    sliding-window keyword overlap. Falls back to fixed N-buckets on
 *    very short transcripts.
 *
 * Streaming preserves the `summariseStream` event vocabulary expected
 * by `LiveAiPanel`. We schedule emissions with a tiny tick so the UI's
 * skeletons get to flash, but the work itself is synchronous (~ms even
 * on long transcripts).
 *
 * Why not just call an LLM? Because the desktop and mobile builds run
 * fully offline by default; this class is the "no-API-key, no-cloud"
 * fallback every shell ships with so the AI panel is never blank.
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
import {
  ABBREVIATIONS,
  detectLanguage,
  isStopword,
  LEXICON,
  stripFiller,
  tokenize,
} from "./stopwords.js";

export interface HeuristicSummarizerOptions {
  /** Per-event delay in ms (lower = snappier). Default 80ms. */
  tickMs?: number;
  /** Provider label that lands in `summary.generatedBy`. */
  label?: string;
  /** Override the auto-detected transcript language. */
  forceLanguage?: string;
}

const DEFAULTS: Required<Omit<HeuristicSummarizerOptions, "forceLanguage">> = {
  tickMs: 80,
  label: "Voxnap (on-device)",
};

interface ScoredSentence {
  index: number;
  text: string;
  tokens: string[];
  contentTokens: string[];
  score: number;
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

// ─── Sentence segmentation ──────────────────────────────────────────

/**
 * Abbreviation-aware sentence splitter.
 *
 * Rules:
 *   • A `.`, `!`, `?` followed by whitespace + an uppercase / digit
 *     starts a new sentence.
 *   • Common abbreviations (per-language, see ABBREVIATIONS) suppress
 *     the split — `Dr. Yılmaz` stays one sentence.
 *   • Ellipses (`...` / `…`) are treated as soft breaks: kept attached
 *     to the previous sentence unless followed by a clear capital.
 */
export function segmentSentences(text: string, language: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return [];

  const abbrev = new Set<string>([
    ...(ABBREVIATIONS[language] ?? []),
    ...(ABBREVIATIONS.en ?? []), // English abbreviations are safe everywhere
  ]);

  const sentences: string[] = [];
  let buf = "";
  let i = 0;

  // Helper: does the buffer end with a known abbreviation?
  const endsWithAbbrev = (s: string): boolean => {
    const lower = s.toLocaleLowerCase().trimEnd();
    for (const a of abbrev) {
      if (lower.endsWith(a)) return true;
    }
    // Also treat single-letter initials like "A." as non-terminal.
    if (/\b[\p{L}]\.$/u.test(lower)) return true;
    return false;
  };

  while (i < cleaned.length) {
    const ch = cleaned[i]!;
    buf += ch;
    if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
      // Look ahead for whitespace + uppercase / digit; if so, terminate.
      // We also accept end-of-string as termination.
      let j = i + 1;
      // Skip trailing punctuation runs (e.g. "?!", "...").
      while (j < cleaned.length && /[.!?…]/.test(cleaned[j]!)) {
        buf += cleaned[j]!;
        j += 1;
      }
      // Whitespace
      let k = j;
      while (k < cleaned.length && /\s/.test(cleaned[k]!)) k += 1;
      const next = cleaned[k];
      const atEnd = k >= cleaned.length;
      const startsNew =
        atEnd ||
        (next != null &&
          (next === next.toLocaleUpperCase() && next !== next.toLocaleLowerCase()) ||
          (next != null && /[\p{N}"“'(]/u.test(next)));
      if (startsNew && !endsWithAbbrev(buf)) {
        const trimmed = buf.trim();
        if (trimmed.length > 0) sentences.push(trimmed);
        buf = "";
        i = k;
        continue;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  const tail = buf.trim();
  if (tail.length > 0) sentences.push(tail);

  return sentences.filter((s) => s.length > 0);
}

// ─── Scoring ────────────────────────────────────────────────────────

interface ScoringInput {
  sentences: string[];
  languages: string[];
}

/**
 * Compute TF-IDF-ish keyword weights and per-sentence scores.
 *
 * The IDF term uses `log(1 + N / df)` so a word appearing in every
 * sentence (df = N) still contributes a tiny weight, while rare-but-
 * informative words get the boost they deserve. Pure TF would over-
 * weight the most repeated stopword fragments that slip past the
 * stopword set.
 */
function scoreSentences({ sentences, languages }: ScoringInput): {
  scored: ScoredSentence[];
  keywordWeights: Map<string, number>;
} {
  const tokenLists: string[][] = sentences.map((s) => tokenize(s));
  const contentLists: string[][] = tokenLists.map((toks) =>
    toks.filter((t) => t.length > 1 && !isStopword(t, languages)),
  );

  const tf = new Map<string, number>();
  const df = new Map<string, number>();
  for (let s = 0; s < contentLists.length; s++) {
    const seenInSentence = new Set<string>();
    for (const t of contentLists[s]!) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      if (!seenInSentence.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1);
        seenInSentence.add(t);
      }
    }
  }

  const N = Math.max(1, contentLists.length);
  const keywordWeights = new Map<string, number>();
  for (const [token, count] of tf) {
    const dfi = df.get(token) ?? 1;
    const idf = Math.log(1 + N / dfi);
    keywordWeights.set(token, count * idf);
  }

  const scored: ScoredSentence[] = sentences.map((text, index) => {
    const tokens = tokenLists[index]!;
    const contentTokens = contentLists[index]!;
    if (contentTokens.length === 0) {
      return { index, text, tokens, contentTokens, score: 0 };
    }
    let total = 0;
    for (const t of contentTokens) {
      total += keywordWeights.get(t) ?? 0;
    }
    let score = total / Math.sqrt(contentTokens.length); // normalise length
    // Lead bias: front-loaded sentences usually carry context.
    const positionBoost = 1 + 0.25 * Math.max(0, 1 - index / Math.max(1, sentences.length / 2));
    score *= positionBoost;
    // Length penalty: too-short or sentence-fragment one-liners are
    // rarely satisfying summaries.
    if (contentTokens.length < 3) score *= 0.4;
    if (text.length > 240) score *= 0.85;
    return { index, text, tokens, contentTokens, score };
  });

  return { scored, keywordWeights };
}

// ─── Selection (TL;DR + bullets) ────────────────────────────────────

interface SelectionResult {
  tldr: string;
  bullets: string[];
}

function selectTldrAndBullets(
  scored: ScoredSentence[],
  language: string,
  count: number,
): SelectionResult {
  if (scored.length === 0) {
    return { tldr: "", bullets: [] };
  }

  // ── TL;DR: highest-scoring sentence in the first ~30% (lead bias).
  const leadCutoff = Math.max(2, Math.floor(scored.length * 0.3));
  const leadCandidates = scored.slice(0, leadCutoff);
  const tldrPick =
    leadCandidates.slice().sort((a, b) => b.score - a.score)[0] ?? scored[0]!;
  const tldrRaw = stripFiller(tldrPick.text, language).replace(/[\s.!?…]+$/, "");
  const tldr = tldrRaw.length > 220 ? tldrRaw.slice(0, 217).trimEnd() + "…" : tldrRaw;

  // ── Bullets: greedy MMR-style selection over remaining sentences.
  const ranked = scored
    .filter((s) => s.index !== tldrPick.index && s.contentTokens.length >= 3)
    .sort((a, b) => b.score - a.score);

  const picked: ScoredSentence[] = [];
  const overlap = (a: ScoredSentence, b: ScoredSentence): number => {
    if (a.contentTokens.length === 0 || b.contentTokens.length === 0) return 0;
    const set = new Set(a.contentTokens);
    let common = 0;
    for (const t of b.contentTokens) if (set.has(t)) common += 1;
    return common / Math.min(a.contentTokens.length, b.contentTokens.length);
  };

  for (const cand of ranked) {
    if (picked.length >= count) break;
    let redundant = false;
    for (const p of picked) {
      if (overlap(cand, p) >= 0.4) {
        redundant = true;
        break;
      }
    }
    if (!redundant) picked.push(cand);
  }

  // If MMR was too strict and we ended up short, top up from `ranked`.
  if (picked.length < count) {
    for (const cand of ranked) {
      if (picked.length >= count) break;
      if (!picked.includes(cand)) picked.push(cand);
    }
  }

  // Sort the bullet output back into transcript order so it reads
  // chronologically — easier to follow during a meeting recap.
  picked.sort((a, b) => a.index - b.index);

  const bullets = picked.map((p) => {
    const cleaned = stripFiller(p.text, language).replace(/\s+/g, " ").trim();
    return cleaned.length > 200 ? cleaned.slice(0, 197).trimEnd() + "…" : cleaned;
  });

  return { tldr, bullets };
}

// ─── Bucket classification ──────────────────────────────────────────

function bucketise(
  sentences: string[],
  languages: string[],
): {
  decisions: string[];
  questions: string[];
  actionTexts: string[];
} {
  const decisions: string[] = [];
  const questions: string[] = [];
  const actionTexts: string[] = [];

  for (const sentence of sentences) {
    const lower = sentence.toLocaleLowerCase();
    let isQuestion = sentence.trim().endsWith("?");
    let isAction = false;
    let isDecision = false;

    for (const lang of languages) {
      const lex = LEXICON[lang];
      if (!lex) continue;
      if (!isQuestion && lex.question.some((q) => containsCue(lower, q))) {
        isQuestion = true;
      }
      if (!isDecision && lex.decision.some((q) => containsCue(lower, q))) {
        isDecision = true;
      }
      if (!isAction && lex.action.some((q) => containsCue(lower, q))) {
        isAction = true;
      }
    }

    if (isQuestion && questions.length < 4 && !questions.includes(sentence)) {
      questions.push(trim(sentence));
    }
    if (isDecision && decisions.length < 4 && !decisions.includes(sentence)) {
      decisions.push(trim(sentence));
    }
    if (isAction && actionTexts.length < 5 && !actionTexts.includes(sentence)) {
      actionTexts.push(trim(sentence));
    }
  }

  return { decisions, questions, actionTexts };
}

function containsCue(haystack: string, cue: string): boolean {
  if (!cue) return false;
  // For multi-word cues a plain `includes` is fine. For single-token
  // cues we want word-boundary semantics so `"ne"` doesn't fire on
  // "kabinet". We approximate boundaries with a simple lookbehind
  // (works in modern JS engines).
  if (cue.includes(" ")) return haystack.includes(cue);
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(cue)}(?=$|[^\\p{L}\\p{N}])`, "u");
  return re.test(haystack);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trim(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197).trimEnd() + "…" : trimmed;
}

// ─── Sentiment ──────────────────────────────────────────────────────

function classifySentiment(
  sentences: string[],
  languages: string[],
): Sentiment {
  let pos = 0;
  let neg = 0;
  for (const s of sentences) {
    const lower = s.toLocaleLowerCase();
    for (const lang of languages) {
      const lex = LEXICON[lang];
      if (!lex) continue;
      for (const w of lex.positive) if (containsCue(lower, w)) pos += 1;
      for (const w of lex.negative) if (containsCue(lower, w)) neg += 1;
    }
  }
  if (pos === 0 && neg === 0) return "neutral";
  if (pos > 0 && neg > 0 && Math.min(pos, neg) / Math.max(pos, neg) >= 0.5) {
    return "mixed";
  }
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

// ─── Chapters ───────────────────────────────────────────────────────

function makeChapters(
  scored: ScoredSentence[],
  durationMs: number,
  language: string,
): Chapter[] {
  if (scored.length === 0 || durationMs <= 0) return [];

  const N = scored.length;
  // Aim for ~1 chapter per 6-8 sentences; cap at 6 chapters total.
  const desired = Math.min(6, Math.max(1, Math.round(N / 7)));
  if (desired <= 1) {
    const title = pickChapterTitle(scored, 0, N - 1, language);
    return [
      {
        id: nanoid(8),
        title,
        startMs: 0,
        endMs: durationMs,
        summary: scored.slice(0, Math.min(2, N)).map((s) => s.text).join(" "),
      },
    ];
  }

  // Find topic-shift boundaries by sliding-window keyword overlap.
  // Compare each adjacent pair of windows of size W; the W positions
  // with the *lowest* overlap score become chapter boundaries.
  const windowSize = Math.max(2, Math.floor(N / desired / 2));
  type Boundary = { index: number; overlap: number };
  const boundaries: Boundary[] = [];
  for (let i = windowSize; i <= N - windowSize; i++) {
    const left = collectTokens(scored, Math.max(0, i - windowSize), i);
    const right = collectTokens(scored, i, Math.min(N, i + windowSize));
    boundaries.push({ index: i, overlap: jaccard(left, right) });
  }
  boundaries.sort((a, b) => a.overlap - b.overlap);
  const chosen = boundaries.slice(0, desired - 1).map((b) => b.index);
  chosen.sort((a, b) => a - b);

  const chapters: Chapter[] = [];
  let prev = 0;
  const cuts = [...chosen, N];
  for (let c = 0; c < cuts.length; c++) {
    const start = prev;
    const end = cuts[c]! - 1;
    if (end < start) continue;
    const startMs = Math.floor((start / N) * durationMs);
    const endMs = Math.floor(((end + 1) / N) * durationMs);
    const title = pickChapterTitle(scored, start, end, language);
    const summary = scored
      .slice(start, end + 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((s) => s.text)
      .join(" ");
    chapters.push({
      id: nanoid(8),
      title,
      startMs,
      endMs,
      summary,
    });
    prev = end + 1;
  }
  return chapters;
}

function collectTokens(
  scored: ScoredSentence[],
  from: number,
  to: number,
): Set<string> {
  const out = new Set<string>();
  for (let i = from; i < to; i++) {
    const s = scored[i];
    if (!s) continue;
    for (const t of s.contentTokens) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const t of a) if (b.has(t)) common += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : common / union;
}

function pickChapterTitle(
  scored: ScoredSentence[],
  from: number,
  to: number,
  language: string,
): string {
  const slice = scored.slice(from, to + 1);
  if (slice.length === 0) return "Bölüm";
  // Pick the highest-scoring sentence and pull its leading 4-6 words.
  const best = slice.slice().sort((a, b) => b.score - a.score)[0]!;
  const cleaned = stripFiller(best.text, language);
  const words = cleaned.split(/\s+/).slice(0, 6).join(" ");
  return words.replace(/[.,;:!?…]+$/, "") || "Bölüm";
}

// ─── Main class ─────────────────────────────────────────────────────

export class HeuristicSummarizer implements ISummarizer {
  private readonly opts: Required<Omit<HeuristicSummarizerOptions, "forceLanguage">> & {
    forceLanguage?: string;
  };

  constructor(opts: HeuristicSummarizerOptions = {}) {
    this.opts = {
      ...DEFAULTS,
      ...opts,
    };
  }

  async summarise(req: SummariseRequest): Promise<SessionSummary> {
    let last: SessionSummary | null = null;
    for await (const ev of this.summariseStream(req)) {
      if (ev.type === "done") last = ev.summary;
    }
    if (last) return last;
    return {
      tldr: "",
      bullets: [],
      decisions: [],
      questions: [],
      sentiment: "neutral",
      generatedAt: new Date().toISOString(),
      generatedBy: this.opts.label,
    };
  }

  async *summariseStream(req: SummariseRequest): AsyncIterable<SummaryStreamEvent> {
    const text = req.segments
      .filter((s) => s.isFinal)
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const targetCount =
      req.length === "short" ? 3 : req.length === "long" ? 7 : 5;

    if (text.length === 0) {
      const summary: SessionSummary = {
        tldr: "",
        bullets: [],
        decisions: [],
        questions: [],
        sentiment: "neutral",
        generatedAt: new Date().toISOString(),
        generatedBy: this.opts.label,
      };
      yield { type: "done", summary };
      return;
    }

    // Detect transcript language. We pass *both* the detected language
    // and English to every downstream classifier so a TR/EN code-switched
    // transcript ("hocam, please check this PR") still classifies the
    // English action cue correctly.
    const detected =
      this.opts.forceLanguage ?? req.outputLanguage ?? detectLanguage(text);
    const languages = Array.from(new Set([detected, "en"]));

    const sentences = segmentSentences(text, detected);
    if (sentences.length === 0) {
      const summary: SessionSummary = {
        tldr: text.slice(0, 200),
        bullets: [],
        decisions: [],
        questions: [],
        sentiment: "neutral",
        generatedAt: new Date().toISOString(),
        generatedBy: this.opts.label,
      };
      yield { type: "done", summary };
      return;
    }

    const { scored } = scoreSentences({ sentences, languages });
    const { tldr, bullets } = selectTldrAndBullets(scored, detected, targetCount);
    const { decisions, questions, actionTexts } = bucketise(sentences, languages);
    const sentiment = classifySentiment(sentences, languages);

    const tick = () => sleep(this.opts.tickMs, req.signal);

    // Initial pause so the UI's "thinking" skeleton has a chance to flash.
    await tick();

    if (tldr) {
      yield { type: "tldr", text: tldr };
    }
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

    const actionItems: ActionItem[] = actionTexts.map((t) => ({
      id: nanoid(8),
      text: t,
      done: false,
    }));
    for (const a of actionItems) {
      await tick();
      yield { type: "actionItem", item: a };
    }

    const lastSeg = req.segments[req.segments.length - 1];
    const duration = lastSeg ? lastSeg.endMs : 0;
    for (const ch of makeChapters(scored, duration, detected)) {
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
    const text = segments
      .filter((s) => s.isFinal)
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0) return "Adsız oturum";
    const lang = this.opts.forceLanguage ?? detectLanguage(text);
    const sentences = segmentSentences(text, lang);
    if (sentences.length === 0) return "Adsız oturum";
    const { scored } = scoreSentences({
      sentences,
      languages: Array.from(new Set([lang, "en"])),
    });
    const best = scored.slice().sort((a, b) => b.score - a.score)[0] ?? scored[0]!;
    const cleaned = stripFiller(best.text, lang);
    const words = cleaned.split(/\s+/).slice(0, 6).join(" ");
    const title = words.replace(/[.,;:!?…]+$/, "");
    return title.length > 0 ? title : "Adsız oturum";
  }
}
