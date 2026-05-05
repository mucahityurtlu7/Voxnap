/**
 * SessionDetailPage — full transcript + summary + action items + chapters + chat.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Star,
  Download,
  Sparkles,
  CheckCircle2,
  ListChecks,
  MessageCircle,
  Bookmark,
  HelpCircle,
  Wand2,
  Clock,
  Languages,
  Send,
} from "lucide-react";
import clsx from "clsx";
import type { Session, SpeakerColor } from "@voxnap/core";

import { useSession, useSessions } from "../hooks/useSessions.js";
import { useSummarizer } from "../engine/SummarizerProvider.js";
import { useToasts } from "../components/ui/Toast.js";
import { Button } from "../components/ui/Button.js";
import { LinkButton } from "../components/ui/LinkButton.js";
import { Badge } from "../components/ui/Badge.js";
import { Avatar } from "../components/ui/Avatar.js";
import { Tabs, TabsList, Tab, TabPanel } from "../components/ui/Tabs.js";
import { Card } from "../components/ui/Card.js";
import { TranscriptView } from "../components/TranscriptView.js";

type TabId = "transcript" | "summary" | "actions" | "chapters" | "chat";

export function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const session = useSession(params.id);
  const { toggleStar, rename, setSummary, setActionItems } = useSessions();
  const summarizer = useSummarizer();
  const { push: toast } = useToasts();
  const [tab, setTab] = useState<TabId>("transcript");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session?.title ?? "");
  const [regenerating, setRegenerating] = useState(false);

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted">
          We couldn't find that session — it may have been deleted.
        </p>
        <LinkButton
          to="/sessions"
          variant="secondary"
          leftIcon={<ArrowLeft className="h-3.5 w-3.5" aria-hidden />}
        >
          Back to sessions
        </LinkButton>
      </div>
    );
  }

  const onRegenerate = async () => {
    setRegenerating(true);
    try {
      const summary = await summarizer.summarise({
        segments: session.segments,
        length: "medium",
      });
      await setSummary(session.id, summary);
      toast({ title: "Summary regenerated", tone: "success" });
    } catch {
      toast({ title: "Failed to regenerate", tone: "danger" });
    } finally {
      setRegenerating(false);
    }
  };

  const onExport = (kind: "md" | "txt" | "srt" | "json") => {
    const content = exportSession(session, kind);
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: `Exported .${kind}`, tone: "success" });
  };

  const commitTitle = async () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== session.title) {
      await rename(session.id, titleDraft.trim());
    } else {
      setTitleDraft(session.title);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <header className="flex flex-col gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          <Link
            to="/sessions"
            className="inline-flex items-center gap-1 hover:text-text"
          >
            <ArrowLeft className="h-3 w-3" />
            Sessions
          </Link>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") {
                    setTitleDraft(session.title);
                    setEditingTitle(false);
                  }
                }}
                className="w-full bg-transparent text-2xl font-semibold tracking-tight text-text outline-none"
              />
            ) : (
              <h1
                className="cursor-text text-2xl font-semibold tracking-tight text-text"
                onClick={() => {
                  setTitleDraft(session.title);
                  setEditingTitle(true);
                }}
              >
                {session.title}
              </h1>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="font-mono">
                {new Date(session.createdAt).toLocaleString()}
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDuration(session.durationMs)}
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Languages className="h-3 w-3" />
                {session.language}
              </span>
              <span>·</span>
              <Badge tone="brand">{session.modelId}</Badge>
              {session.tags.map((t) => (
                <Badge key={t.id} tone={(t.color ?? "neutral") as SpeakerColor}>
                  {t.label}
                </Badge>
              ))}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant={session.starred ? "subtle" : "ghost"}
              size="sm"
              leftIcon={
                <Star
                  className={clsx(
                    "h-3.5 w-3.5",
                    session.starred && "fill-amber-500 text-amber-500",
                  )}
                />
              }
              onClick={() => void toggleStar(session.id)}
            >
              {session.starred ? "Starred" : "Star"}
            </Button>
            <ExportMenu onPick={onExport} />
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <Tab value="transcript">Transcript</Tab>
          <Tab value="summary">Summary</Tab>
          <Tab value="actions">
            Actions
            {session.actionItems.length > 0 && (
              <span className="ml-1 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">
                {session.actionItems.length}
              </span>
            )}
          </Tab>
          <Tab value="chapters">Chapters</Tab>
          <Tab value="chat">Chat</Tab>
        </TabsList>

        <TabPanel value="transcript">
          <div className="h-[60vh] min-h-[360px]">
            <TranscriptView
              finals={session.segments}
              interim={null}
              speakers={session.speakers}
            />
          </div>
        </TabPanel>

        <TabPanel value="summary">
          <SummaryView
            session={session}
            regenerating={regenerating}
            onRegenerate={onRegenerate}
          />
        </TabPanel>

        <TabPanel value="actions">
          <ActionItemsView
            session={session}
            onChange={(items) => void setActionItems(session.id, items)}
          />
        </TabPanel>

        <TabPanel value="chapters">
          <ChaptersView session={session} />
        </TabPanel>

        <TabPanel value="chat">
          <ChatView session={session} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

const EXPORT_KINDS = [
  { id: "md", label: "Markdown", hint: ".md" },
  { id: "txt", label: "Plain text", hint: ".txt" },
  { id: "srt", label: "Subtitles", hint: ".srt" },
  { id: "json", label: "Raw data", hint: ".json" },
] as const;

function ExportMenu({ onPick }: { onPick: (kind: "md" | "txt" | "srt" | "json") => void }) {
  const [open, setOpen] = useState(false);

  // Esc to close — small QoL win that costs nothing.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Download className="h-3.5 w-3.5" aria-hidden />}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Export
      </Button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            aria-label="Export format"
            className="absolute right-0 z-40 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-surface shadow-soft animate-fade-in"
          >
            {EXPORT_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(k.id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-xs text-text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-text focus-visible:bg-surface-3 focus-visible:text-text"
              >
                <span>{k.label}</span>
                <span className="font-mono text-[10px] text-muted">{k.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryView({
  session,
  onRegenerate,
  regenerating,
}: {
  session: Session;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const summary = session.summary;
  if (!summary) {
    return (
      <Card className="p-6 text-center">
        <p className="mb-3 text-sm text-muted">
          This session doesn't have a summary yet.
        </p>
        <Button
          variant="primary"
          leftIcon={<Sparkles className="h-3.5 w-3.5" />}
          loading={regenerating}
          onClick={onRegenerate}
        >
          Generate summary
        </Button>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <div className="vx-eyebrow mb-2 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-brand-500" />
            TL;DR
          </div>
          <p className="text-sm font-medium leading-relaxed text-text">
            {summary.tldr}
          </p>
        </Card>

        <Card className="p-5">
          <div className="vx-eyebrow mb-2 flex items-center gap-1.5">
            <ListChecks className="h-3.5 w-3.5 text-brand-500" />
            Highlights
          </div>
          <ul className="flex flex-col gap-2">
            {summary.bullets.map((b, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-text-subtle"
              >
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </Card>

        {summary.decisions.length > 0 && (
          <Card className="p-5">
            <div className="vx-eyebrow mb-2 flex items-center gap-1.5">
              <Bookmark className="h-3.5 w-3.5 text-emerald-500" />
              Decisions
            </div>
            <ul className="flex flex-col gap-2">
              {summary.decisions.map((d, i) => (
                <li key={i} className="text-sm text-text-subtle">
                  · {d}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {summary.questions.length > 0 && (
          <Card className="p-5">
            <div className="vx-eyebrow mb-2 flex items-center gap-1.5">
              <HelpCircle className="h-3.5 w-3.5 text-amber-500" />
              Open questions
            </div>
            <ul className="flex flex-col gap-2">
              {summary.questions.map((q, i) => (
                <li key={i} className="text-sm text-text-subtle">
                  ? {q}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Card className="h-fit p-5">
        <div className="vx-eyebrow mb-3">Meta</div>
        <dl className="space-y-3 text-xs">
          <Row label="Sentiment">
            <SentimentBadge sentiment={summary.sentiment} />
          </Row>
          <Row label="Generated">
            {new Date(summary.generatedAt).toLocaleString()}
          </Row>
          <Row label="Model">
            <span className="font-mono text-[11px]">{summary.generatedBy}</span>
          </Row>
        </dl>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Wand2 className="h-3.5 w-3.5" />}
          loading={regenerating}
          onClick={onRegenerate}
          className="mt-4 w-full"
        >
          Regenerate
        </Button>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-right text-text-subtle">{children}</dd>
    </div>
  );
}

function SentimentBadge({ sentiment }: { sentiment: "positive" | "neutral" | "negative" | "mixed" }) {
  const tone =
    sentiment === "positive"
      ? "success"
      : sentiment === "negative"
        ? "danger"
        : sentiment === "mixed"
          ? "warning"
          : "neutral";
  return <Badge tone={tone as "success"}>{sentiment}</Badge>;
}

function ActionItemsView({
  session,
  onChange,
}: {
  session: Session;
  onChange: (items: typeof session.actionItems) => void;
}) {
  const items = session.actionItems;
  const toggle = (id: string) =>
    onChange(items.map((a) => (a.id === id ? { ...a, done: !a.done } : a)));

  if (items.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted">
        No action items extracted for this session.
      </Card>
    );
  }

  const done = items.filter((a) => a.done).length;
  const progress = (done / items.length) * 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        <span>
          {done} of {items.length} done
        </span>
        <div className="ml-auto h-1.5 w-32 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-brand-gradient transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <li
            key={a.id}
            className={clsx(
              "flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-sm transition-colors",
              a.done && "opacity-60",
            )}
          >
            <input
              type="checkbox"
              checked={a.done}
              onChange={() => toggle(a.id)}
              className="mt-1 h-4 w-4 accent-brand-500"
            />
            <div className="min-w-0 flex-1">
              <div
                className={clsx(
                  "text-text",
                  a.done && "line-through decoration-muted",
                )}
              >
                {a.text}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                {a.owner && (
                  <span className="inline-flex items-center gap-1">
                    <Avatar label={a.owner} color="violet" size="xs" />
                    {a.owner}
                  </span>
                )}
                {a.dueAt && (
                  <span>· due {new Date(a.dueAt).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChaptersView({ session }: { session: Session }) {
  if (session.chapters.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted">
        No chapters extracted for this session.
      </Card>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {session.chapters.map((c, i) => (
        <li key={c.id} className="flex gap-3">
          <div className="flex shrink-0 flex-col items-center">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-gradient text-[11px] font-semibold text-white shadow-glow">
              {i + 1}
            </div>
            {i < session.chapters.length - 1 && (
              <div className="my-1 w-px flex-1 bg-border" />
            )}
          </div>
          <Card className="flex-1 p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text">{c.title}</h3>
              <span className="font-mono text-[11px] text-muted">
                {formatMs(c.startMs)} → {formatMs(c.endMs)}
              </span>
            </div>
            <p className="text-xs text-text-subtle">{c.summary}</p>
          </Card>
        </li>
      ))}
    </ol>
  );
}

function ChatView({ session }: { session: Session }) {
  const [messages, setMessages] = useState<{ role: "user" | "ai"; text: string }[]>([
    {
      role: "ai",
      text:
        session.summary?.tldr
          ? `I've read this session. ${session.summary.tldr} Ask me anything about it.`
          : "I've read this session. Ask me anything about it.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest message.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = () => {
    const q = draft.trim();
    if (!q) return;
    const reply = mockAnswer(q, session);
    setMessages((m) => [...m, { role: "user", text: q }, { role: "ai", text: reply }]);
    setDraft("");
  };

  return (
    <Card className="flex h-[60vh] min-h-[420px] flex-col overflow-hidden">
      <div
        ref={scrollerRef}
        className="flex-1 space-y-3 overflow-y-auto p-4"
        role="log"
        aria-live="polite"
        aria-label="Chat transcript"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={clsx(
              "flex gap-2",
              m.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            {m.role === "ai" && (
              <span
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white"
                aria-hidden
              >
                <Sparkles className="h-3 w-3" />
              </span>
            )}
            <div
              className={clsx(
                "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed",
                m.role === "user"
                  ? "bg-brand-500 text-white"
                  : "bg-surface-2 text-text",
              )}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 border-t border-border bg-surface-2 p-3">
        <label htmlFor="vx-chat-input" className="sr-only">
          Ask this transcript a question
        </label>
        <input
          id="vx-chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask this transcript anything…"
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20"
        />
        <Button
          variant="primary"
          size="md"
          leftIcon={<Send className="h-3.5 w-3.5" aria-hidden />}
          onClick={send}
          disabled={!draft.trim()}
        >
          Ask
        </Button>
      </div>
      <p className="flex items-center gap-1.5 border-t border-border bg-surface-2 px-3 py-2 text-[11px] text-muted">
        <MessageCircle className="h-3 w-3" aria-hidden />
        Mock answers — wire a real provider in Settings · AI to enable grounded chat.
      </p>
    </Card>
  );
}

function mockAnswer(question: string, session: Session): string {
  const q = question.toLowerCase();
  const summary = session.summary;
  if (/tl;?dr|summary|özet/i.test(q)) {
    return summary?.tldr ?? "I don't have a summary for this session yet.";
  }
  if (/action|todo|task/i.test(q)) {
    if (session.actionItems.length === 0) return "No action items were extracted.";
    return (
      "Here are the action items:\n" +
      session.actionItems.map((a) => `• ${a.text}${a.owner ? ` (${a.owner})` : ""}`).join("\n")
    );
  }
  if (/decision|karar/i.test(q)) {
    if (!summary || summary.decisions.length === 0) return "No decisions captured.";
    return summary.decisions.map((d) => `• ${d}`).join("\n");
  }
  if (/who|kim/i.test(q)) {
    if (session.speakers.length === 0) return "No speakers were labelled.";
    return "Speakers: " + session.speakers.map((s) => s.label).join(", ");
  }
  if (/long|how long|süre|duration/i.test(q)) {
    return `This session was ${formatDuration(session.durationMs)}.`;
  }
  return "I'm a mock LLM — try asking about the summary, action items, decisions, speakers or duration. Real answers will arrive once you wire a provider in Settings.";
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

function exportSession(s: Session, kind: "md" | "txt" | "srt" | "json"): string {
  if (kind === "json") return JSON.stringify(s, null, 2);
  if (kind === "txt") return s.segments.map((seg) => seg.text).join("\n");
  if (kind === "srt") {
    return s.segments
      .map((seg, i) => {
        return [
          String(i + 1),
          `${srtTime(seg.startMs)} --> ${srtTime(seg.endMs)}`,
          seg.text,
          "",
        ].join("\n");
      })
      .join("\n");
  }
  // markdown
  const lines: string[] = [];
  lines.push(`# ${s.title}`);
  lines.push("");
  lines.push(`*${new Date(s.createdAt).toLocaleString()} · ${formatDuration(s.durationMs)} · ${s.language}*`);
  lines.push("");
  if (s.summary) {
    lines.push("## TL;DR");
    lines.push(s.summary.tldr);
    lines.push("");
    lines.push("## Highlights");
    for (const b of s.summary.bullets) lines.push(`- ${b}`);
    lines.push("");
    if (s.summary.decisions.length) {
      lines.push("## Decisions");
      for (const d of s.summary.decisions) lines.push(`- ${d}`);
      lines.push("");
    }
  }
  if (s.actionItems.length) {
    lines.push("## Action items");
    for (const a of s.actionItems)
      lines.push(`- [${a.done ? "x" : " "}] ${a.text}${a.owner ? ` _(${a.owner})_` : ""}`);
    lines.push("");
  }
  lines.push("## Transcript");
  for (const seg of s.segments) {
    lines.push(`**${formatMs(seg.startMs)}** ${seg.text}`);
  }
  return lines.join("\n");
}

function srtTime(ms: number): string {
  const total = Math.floor(ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const cs = total % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(cs, 3)}`;
}
function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}
