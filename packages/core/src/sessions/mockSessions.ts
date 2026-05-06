/**
 * Mock seed data for the Sessions / Summaries / Insights pages.
 *
 * The shape is hand-crafted to look like real Voxnap sessions so the UI
 * can render its full information density (chapters, action items,
 * sentiment, multi-speaker badges, mixed languages) without a backend.
 *
 * IDs are stable so `localStorage` round-trips don't surprise us in dev.
 */
import type {
  ActionItem,
  Chapter,
  Session,
  SessionSummary,
  Speaker,
  TranscriptionSegment,
} from "../types.js";

interface SegBuilder {
  text: string;
  ms: number;
  speakerId?: string;
  language?: string;
}

const speakerPalette: Speaker[] = [
  { id: "you", label: "You", color: "violet" },
  { id: "alex", label: "Alex", color: "sky" },
  { id: "selin", label: "Selin", color: "emerald" },
  { id: "mira", label: "Mira", color: "amber" },
  { id: "kenji", label: "Kenji", color: "rose" },
];

let idCounter = 0;
const segId = () => `seg_${(++idCounter).toString(36)}`;

function buildSegments(rows: SegBuilder[]): TranscriptionSegment[] {
  let cursor = 0;
  return rows.map((r) => {
    const start = cursor;
    cursor += r.ms;
    return {
      id: segId(),
      text: r.text,
      startMs: start,
      endMs: cursor,
      isFinal: true,
      confidence: 0.9 + Math.random() * 0.08,
      language: r.language ?? "en",
      speakerId: r.speakerId,
    };
  });
}

function summary(
  tldr: string,
  bullets: string[],
  decisions: string[],
  questions: string[],
  generatedAt: string,
  generatedBy = "Voxnap Mock · gpt-pretend-4",
  sentiment: SessionSummary["sentiment"] = "neutral",
): SessionSummary {
  return { tldr, bullets, decisions, questions, sentiment, generatedAt, generatedBy };
}

function makeChapters(
  segs: TranscriptionSegment[],
  parts: { title: string; summary: string; sliceTo: number }[],
): Chapter[] {
  const total = segs[segs.length - 1]?.endMs ?? 0;
  const out: Chapter[] = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const end = i === parts.length - 1 ? total : segs[p.sliceTo - 1]?.endMs ?? cursor;
    out.push({
      id: `ch_${i}_${Math.random().toString(36).slice(2, 6)}`,
      title: p.title,
      summary: p.summary,
      startMs: cursor,
      endMs: end,
    });
    cursor = end;
  }
  return out;
}

function ai(
  text: string,
  owner?: string,
  dueAt?: string,
  done = false,
): ActionItem {
  return {
    id: `ai_${Math.random().toString(36).slice(2, 8)}`,
    text,
    owner,
    dueAt,
    done,
  };
}

const days = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(10 + (n % 6), (n * 7) % 60, 0, 0);
  return d.toISOString();
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const s1Segments = buildSegments([
  { text: "Alright, let's kick off the Voxnap design review.", ms: 2400, speakerId: "you" },
  { text: "I'm sharing the new live transcription mockups now.", ms: 2200, speakerId: "you" },
  { text: "Looks great — the live AI panel is exactly what I had in mind.", ms: 2600, speakerId: "alex" },
  { text: "I love that the TL;DR streams in while you're still talking.", ms: 2400, speakerId: "alex" },
  { text: "We should make sure action items can be reordered and assigned.", ms: 2800, speakerId: "selin" },
  { text: "Agreed. Let's add owner avatars and a due date picker next week.", ms: 2900, speakerId: "you" },
  { text: "What about export — markdown, SRT and JSON?", ms: 2200, speakerId: "alex" },
  { text: "Yes, all three. Let's wire that into the session detail page.", ms: 2400, speakerId: "you" },
  { text: "Can we ship a command palette in v0.2?", ms: 1800, speakerId: "selin" },
  { text: "Definitely. ⌘K is already in the design.", ms: 1500, speakerId: "you" },
]);

const session1: Session = {
  id: "sess_design_review_v02",
  title: "Voxnap design review — v0.2",
  createdAt: days(0),
  durationMs: s1Segments[s1Segments.length - 1]!.endMs,
  language: "en",
  modelId: "base.q5_1",
  tags: [
    { id: "t_design", label: "design", color: "violet" },
    { id: "t_team", label: "team", color: "sky" },
  ],
  starred: true,
  speakers: [speakerPalette[0]!, speakerPalette[1]!, speakerPalette[2]!],
  segments: s1Segments,
  summary: summary(
    "Reviewed the v0.2 live transcription redesign and aligned on next steps.",
    [
      "The streaming TL;DR and live AI panel were well received.",
      "Action items need owner avatars and due-date pickers.",
      "Markdown / SRT / JSON export will land in the session detail page.",
      "Command palette (⌘K) is confirmed for v0.2.",
    ],
    [
      "Ship export menu (md/srt/json) in session detail.",
      "Add owner + due date to action items next sprint.",
    ],
    ["What's the cut-off for v0.2 features?"],
    days(0),
    "Voxnap Mock · gpt-pretend-4",
    "positive",
  ),
  actionItems: [
    ai("Add owner avatars to action items", "Selin", days(-7)),
    ai("Wire export (md/srt/json) into session detail", "Mucahit", days(-5)),
    ai("Polish command palette UX", "Alex", days(-3)),
    ai("Schedule v0.2 demo for stakeholders", "Mucahit", days(-2), true),
  ],
  chapters: makeChapters(s1Segments, [
    { title: "Kick-off", summary: "Opening the design review.", sliceTo: 2 },
    { title: "Live AI panel", summary: "Feedback on streaming TL;DR + bullets.", sliceTo: 4 },
    { title: "Action items UX", summary: "Owner, avatars, due dates.", sliceTo: 7 },
    { title: "Export & shortcuts", summary: "Export menu and ⌘K palette.", sliceTo: 10 },
  ]),
};

const s2Segments = buildSegments([
  { text: "Hoş geldin Selin, bu hafta neler oldu?", ms: 2200, speakerId: "you", language: "tr" },
  { text: "Whisper.cpp tarafında base modelini quantize ettim, yüzde otuz hız kazandık.", ms: 3200, speakerId: "selin", language: "tr" },
  { text: "Harika. Pil tüketimi nasıl?", ms: 1800, speakerId: "you", language: "tr" },
  { text: "Mobilde belirgin bir fark yok, masaüstünde biraz daha iyi.", ms: 2600, speakerId: "selin", language: "tr" },
  { text: "Hafıza ne kadar düştü?", ms: 1500, speakerId: "you", language: "tr" },
  { text: "Yaklaşık iki yüz megabayt aşağı indi.", ms: 1900, speakerId: "selin", language: "tr" },
  { text: "Süper, bu hafta yayına alalım. Test planı hazır mı?", ms: 2400, speakerId: "you", language: "tr" },
  { text: "Evet, bugün gönderiyorum. Action item olarak yazalım.", ms: 2200, speakerId: "selin", language: "tr" },
]);

const session2: Session = {
  id: "sess_perf_huddle_tr",
  title: "Performans toplantısı — quantize sonrası",
  createdAt: days(2),
  durationMs: s2Segments[s2Segments.length - 1]!.endMs,
  language: "tr",
  modelId: "small.q5_1",
  tags: [
    { id: "t_perf", label: "performance", color: "emerald" },
    { id: "t_mobile", label: "mobile", color: "amber" },
  ],
  starred: false,
  speakers: [speakerPalette[0]!, speakerPalette[2]!],
  segments: s2Segments,
  summary: summary(
    "Quantize'lı base modeliyle %30 hız ve ~200MB hafıza kazandık.",
    [
      "Base modeli quantize edildi, %30 hız kazancı sağlandı.",
      "Masaüstünde pil tüketimi iyileşti, mobilde benzer kaldı.",
      "Hafıza kullanımı yaklaşık 200MB azaldı.",
      "Bu hafta yayın planlandı; test planı bugün paylaşılacak.",
    ],
    [
      "Quantize edilmiş base modelini bu hafta release et.",
      "Test planını bugün paylaş.",
    ],
    ["Mobile pil tüketimini ayrıca ölçmemiz gerekir mi?"],
    days(2),
    "Voxnap Mock · gpt-pretend-4",
    "positive",
  ),
  actionItems: [
    ai("Test planını paylaş", "Selin", days(1)),
    ai("Release notlarını yaz", "Mucahit", days(0)),
    ai("Mobil pil ölçümünü planla", "Selin"),
  ],
  chapters: makeChapters(s2Segments, [
    { title: "Quantize sonuçları", summary: "%30 hız, 200MB hafıza kazancı.", sliceTo: 4 },
    { title: "Pil ve hafıza", summary: "Masaüstü iyileşti, mobil aynı.", sliceTo: 6 },
    { title: "Yayın planı", summary: "Bu hafta release, test planı bugün.", sliceTo: 8 },
  ]),
};

const s3Segments = buildSegments([
  { text: "Quick standup — what's blocking you today?", ms: 1900, speakerId: "you" },
  { text: "Web build is failing on the worklet path resolution.", ms: 2400, speakerId: "alex" },
  { text: "Did you try the new Vite alias?", ms: 1500, speakerId: "you" },
  { text: "I will, give me an hour.", ms: 1200, speakerId: "alex" },
  { text: "Mira, anything from your side?", ms: 1500, speakerId: "you" },
  { text: "Just polishing the onboarding flow. No blockers.", ms: 2200, speakerId: "mira" },
]);

const session3: Session = {
  id: "sess_standup_mon",
  title: "Monday standup",
  createdAt: days(3),
  durationMs: s3Segments[s3Segments.length - 1]!.endMs,
  language: "en",
  modelId: "tiny.en.q5_1",
  tags: [{ id: "t_standup", label: "standup", color: "sky" }],
  starred: false,
  speakers: [speakerPalette[0]!, speakerPalette[1]!, speakerPalette[3]!],
  segments: s3Segments,
  summary: summary(
    "Short Monday standup with one blocker on the web build.",
    [
      "Alex is debugging a worklet path resolution issue in the web build.",
      "Mira has no blockers; finishing the onboarding flow.",
    ],
    ["Alex will try the new Vite alias today."],
    [],
    days(3),
    "Voxnap Mock · gpt-pretend-4",
    "neutral",
  ),
  actionItems: [
    ai("Try the new Vite alias for worklet path", "Alex", days(2)),
    ai("Finish onboarding flow polish", "Mira"),
  ],
  chapters: makeChapters(s3Segments, [
    { title: "Blockers", summary: "Web build worklet issue.", sliceTo: 4 },
    { title: "In-progress", summary: "Onboarding polish.", sliceTo: 6 },
  ]),
};

const s4Segments = buildSegments([
  { text: "Ideas for the upcoming launch trailer.", ms: 1800, speakerId: "you" },
  { text: "What if we open with a real microphone shot?", ms: 2200, speakerId: "alex" },
  { text: "Then snap to the live transcript scrolling.", ms: 2000, speakerId: "alex" },
  { text: "Love it. The TL;DR animating in would be the punch.", ms: 2400, speakerId: "you" },
  { text: "Keep it under 30 seconds.", ms: 1500, speakerId: "you" },
  { text: "Music suggestion: something low-key and synthy.", ms: 2200, speakerId: "alex" },
  { text: "Let's storyboard it tomorrow.", ms: 1800, speakerId: "you" },
]);

const session4: Session = {
  id: "sess_launch_trailer",
  title: "Launch trailer brainstorm",
  createdAt: days(5),
  durationMs: s4Segments[s4Segments.length - 1]!.endMs,
  language: "en",
  modelId: "base.q5_1",
  tags: [
    { id: "t_marketing", label: "marketing", color: "rose" },
    { id: "t_brainstorm", label: "brainstorm", color: "fuchsia" },
  ],
  starred: true,
  speakers: [speakerPalette[0]!, speakerPalette[1]!],
  segments: s4Segments,
  summary: summary(
    "Trailer concept locked in: mic shot → live transcript → TL;DR punch, ≤30s.",
    [
      "Open on a real microphone, cut to live transcript scrolling.",
      "TL;DR animates in as the punch line.",
      "Keep total length under 30 seconds.",
      "Music: low-key synth.",
    ],
    ["Storyboard the trailer tomorrow."],
    [],
    days(5),
    "Voxnap Mock · gpt-pretend-4",
    "positive",
  ),
  actionItems: [
    ai("Storyboard launch trailer", "Alex", days(4)),
    ai("Find low-key synth music options", "Mucahit", days(3)),
  ],
  chapters: makeChapters(s4Segments, [
    { title: "Visual concept", summary: "Mic + transcript + TL;DR.", sliceTo: 4 },
    { title: "Constraints", summary: "Under 30 seconds, synth music.", sliceTo: 7 },
  ]),
};

const s5Segments = buildSegments([
  { text: "Customer interview with a podcast producer.", ms: 1800, speakerId: "you" },
  { text: "I record three shows a week and editing is a pain.", ms: 2400, speakerId: "kenji" },
  { text: "What do you want from a transcription tool?", ms: 1800, speakerId: "you" },
  { text: "Speaker labels and clean exports. And a TL;DR for show notes.", ms: 2800, speakerId: "kenji" },
  { text: "Privacy is critical — recordings can't leave my machine.", ms: 2400, speakerId: "kenji" },
  { text: "Voxnap is on-device by default. That fits.", ms: 2200, speakerId: "you" },
  { text: "Then I'd switch tomorrow.", ms: 1500, speakerId: "kenji" },
]);

const session5: Session = {
  id: "sess_user_interview_kenji",
  title: "User interview · podcast producer",
  createdAt: days(7),
  durationMs: s5Segments[s5Segments.length - 1]!.endMs,
  language: "en",
  modelId: "small.q5_1",
  tags: [
    { id: "t_research", label: "user-research", color: "cyan" },
    { id: "t_podcast", label: "podcast", color: "amber" },
  ],
  starred: false,
  speakers: [speakerPalette[0]!, speakerPalette[4]!],
  segments: s5Segments,
  summary: summary(
    "Strong fit: producer would switch for on-device transcription with speaker labels and TL;DR show notes.",
    [
      "Records three shows weekly; editing is the bottleneck.",
      "Wants speaker labels, clean exports, TL;DR show notes.",
      "Privacy is non-negotiable — recordings must stay local.",
      "Said they'd switch to Voxnap immediately if available.",
    ],
    [],
    ["When can we offer speaker diarisation?"],
    days(7),
    "Voxnap Mock · gpt-pretend-4",
    "positive",
  ),
  actionItems: [
    ai("Prioritise speaker diarisation roadmap", "Mucahit"),
    ai("Add 'show notes' export template", "Selin"),
  ],
  chapters: makeChapters(s5Segments, [
    { title: "Pain points", summary: "Three shows/week, editing is slow.", sliceTo: 3 },
    { title: "Wishlist", summary: "Speaker labels, exports, TL;DR notes.", sliceTo: 5 },
    { title: "Privacy fit", summary: "On-device alignment.", sliceTo: 7 },
  ]),
};

const s6Segments = buildSegments([
  { text: "Solo voice memo: ideas for the Insights page.", ms: 2000, speakerId: "you" },
  { text: "I want a heatmap of when I record the most.", ms: 2200, speakerId: "you" },
  { text: "Plus my top words across the past month.", ms: 2000, speakerId: "you" },
  { text: "Maybe a sentiment trend line.", ms: 1700, speakerId: "you" },
  { text: "Could be cool to see most active speakers if shared.", ms: 2200, speakerId: "you" },
]);

const session6: Session = {
  id: "sess_voice_memo_insights",
  title: "Voice memo · Insights ideas",
  createdAt: days(9),
  durationMs: s6Segments[s6Segments.length - 1]!.endMs,
  language: "en",
  modelId: "tiny.q5_1",
  tags: [{ id: "t_memo", label: "memo", color: "violet" }],
  starred: false,
  speakers: [speakerPalette[0]!],
  segments: s6Segments,
  summary: summary(
    "Insights page wishlist: heatmap, top words, sentiment trend, top speakers.",
    [
      "Recording-time heatmap.",
      "Top words across the last month.",
      "Sentiment trend line.",
      "Most active speakers when sessions are shared.",
    ],
    [],
    [],
    days(9),
    "Voxnap Mock · gpt-pretend-4",
    "neutral",
  ),
  actionItems: [ai("Sketch Insights wireframe", "Mucahit", days(7))],
  chapters: makeChapters(s6Segments, [
    { title: "Wishlist", summary: "Heatmap, top words, sentiment.", sliceTo: 5 },
  ]),
};

const s7Segments = buildSegments([
  { text: "Lecture: Introduction to streaming ASR.", ms: 2200, speakerId: "you" },
  { text: "Whisper is an encoder-decoder transformer.", ms: 2400, speakerId: "you" },
  { text: "It outputs tokens that can be decoded incrementally.", ms: 2800, speakerId: "you" },
  { text: "VAD helps reduce wasted compute on silence.", ms: 2400, speakerId: "you" },
  { text: "Quantization shrinks the model with minimal accuracy loss.", ms: 2800, speakerId: "you" },
  { text: "On the edge, we trade size and speed for quality.", ms: 2600, speakerId: "you" },
]);

const session7: Session = {
  id: "sess_lecture_streaming_asr",
  title: "Lecture · streaming ASR fundamentals",
  createdAt: days(12),
  durationMs: s7Segments[s7Segments.length - 1]!.endMs,
  language: "en",
  modelId: "medium.q5_0",

  tags: [
    { id: "t_lecture", label: "lecture", color: "sky" },
    { id: "t_asr", label: "asr", color: "emerald" },
  ],
  starred: false,
  speakers: [speakerPalette[0]!],
  segments: s7Segments,
  summary: summary(
    "Streaming ASR primer: Whisper architecture, VAD, quantization trade-offs.",
    [
      "Whisper is an encoder-decoder transformer.",
      "Tokens can be decoded incrementally for streaming.",
      "VAD avoids spending compute on silence.",
      "Quantization shrinks the model with little accuracy loss.",
      "Edge deployments trade size and speed for quality.",
    ],
    [],
    ["What's the latency floor of Whisper-base on a Pixel?"],
    days(12),
    "Voxnap Mock · gpt-pretend-4",
    "neutral",
  ),
  actionItems: [],
  chapters: makeChapters(s7Segments, [
    { title: "Architecture", summary: "Encoder-decoder transformer.", sliceTo: 3 },
    { title: "Optimisations", summary: "VAD and quantization.", sliceTo: 6 },
  ]),
};

const s8Segments = buildSegments([
  { text: "1:1 with Mira about the onboarding flow.", ms: 2000, speakerId: "you" },
  { text: "First-run experience needs a model download progress.", ms: 2400, speakerId: "mira" },
  { text: "And a microphone permission walkthrough.", ms: 2000, speakerId: "mira" },
  { text: "Let's also offer a mock mode for first launch.", ms: 2200, speakerId: "you" },
  { text: "Great idea, that removes the download blocker.", ms: 2200, speakerId: "mira" },
  { text: "We can prompt to download a model after the first session.", ms: 2400, speakerId: "you" },
]);

const session8: Session = {
  id: "sess_1on1_onboarding",
  title: "1:1 — onboarding flow",
  createdAt: days(14),
  durationMs: s8Segments[s8Segments.length - 1]!.endMs,
  language: "en",
  modelId: "base.q5_1",
  tags: [
    { id: "t_onboarding", label: "onboarding", color: "amber" },
    { id: "t_one_on_one", label: "1:1", color: "violet" },
  ],
  starred: false,
  speakers: [speakerPalette[0]!, speakerPalette[3]!],
  segments: s8Segments,
  summary: summary(
    "First-run UX: progress for model download, mic permission walkthrough, mock mode by default.",
    [
      "Show model download progress on first run.",
      "Walkthrough for the microphone permission prompt.",
      "Default to mock mode so users can try Voxnap instantly.",
      "Prompt to download a real model after the first session.",
    ],
    [
      "Default first launch to mock mode.",
      "Add 'download model' prompt after first session.",
    ],
    [],
    days(14),
    "Voxnap Mock · gpt-pretend-4",
    "positive",
  ),
  actionItems: [
    ai("Wire mock mode as default first-run engine", "Mucahit", days(11)),
    ai("Design model download progress sheet", "Mira", days(10)),
  ],
  chapters: makeChapters(s8Segments, [
    { title: "Friction points", summary: "Download + mic permission.", sliceTo: 3 },
    { title: "Mock-first launch", summary: "Try-then-download flow.", sliceTo: 6 },
  ]),
};

export const MOCK_SESSIONS: Session[] = [
  session1,
  session2,
  session3,
  session4,
  session5,
  session6,
  session7,
  session8,
];
