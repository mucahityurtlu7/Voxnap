/**
 * InsightsPage — light personal analytics over saved sessions.
 *
 * Hand-rolled SVG charts, no chart library. Computes everything from the
 * sessions store at render time.
 */
import { useMemo } from "react";
import { Activity, Languages, MessageCircle, Smile } from "lucide-react";
import type { Sentiment } from "@voxnap/core";

import { useSessions } from "../hooks/useSessions.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Badge } from "../components/ui/Badge.js";

interface DailyBucket {
  day: string;
  ms: number;
}

const STOP_WORDS = new Set([
  "the", "and", "a", "an", "to", "of", "in", "is", "it", "that", "for",
  "on", "with", "as", "this", "be", "are", "we", "i", "you", "or", "if",
  "but", "at", "by", "from", "have", "has", "was", "were", "will", "do",
  "ve", "bir", "bu", "ile", "için", "ne", "de", "da", "ki", "mi", "mı",
]);

export function InsightsPage() {
  const { sessions } = useSessions();

  const data = useMemo(() => computeInsights(sessions), [sessions]);

  if (sessions.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl p-6">
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title="No insights yet"
          description="Once you have a few sessions, this dashboard will fill up with charts."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Insights</h1>
        <p className="text-xs text-muted">
          A quick look at how often you record, what you talk about and how it
          tends to land.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Sessions"
          value={String(sessions.length)}
          hint={`${data.thisWeek} this week`}
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Total talk time"
          value={formatTotal(data.totalMs)}
          hint={`avg ${formatTotal(data.avgMs)}`}
          icon={<MessageCircle className="h-4 w-4" />}
        />
        <StatCard
          label="Languages"
          value={String(data.languages.size)}
          hint={[...data.languages].join(", ").toUpperCase()}
          icon={<Languages className="h-4 w-4" />}
        />
        <StatCard
          label="Avg sentiment"
          value={data.dominantSentiment.toUpperCase()}
          hint="across all summaries"
          icon={<Smile className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="p-5">
          <div className="vx-eyebrow mb-3">Last 14 days · talk time</div>
          <DailyChart data={data.daily} />
        </Card>

        <Card className="p-5">
          <div className="vx-eyebrow mb-3">Top words</div>
          {data.topWords.length === 0 ? (
            <p className="text-xs text-muted">Not enough data yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.topWords.map((w, i) => (
                <li key={w.word} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-right font-mono text-muted">
                    {i + 1}
                  </span>
                  <span className="font-medium text-text">{w.word}</span>
                  <div className="ml-auto flex w-32 items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className="h-full rounded-full bg-brand-gradient"
                        style={{ width: `${(w.count / data.topWords[0]!.count) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right font-mono text-muted">
                      {w.count}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <div className="vx-eyebrow mb-3">Sentiment mix</div>
          <SentimentBars data={data.sentimentCounts} />
        </Card>

        <Card className="p-5">
          <div className="vx-eyebrow mb-3">Top tags</div>
          <div className="flex flex-wrap gap-2">
            {data.topTags.length === 0 && (
              <p className="text-xs text-muted">Tag your sessions to see them here.</p>
            )}
            {data.topTags.map(([label, count]) => (
              <Badge key={label} tone="brand">
                {label} · {count}
              </Badge>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-gradient-soft text-brand-500">
          {icon}
        </span>
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-text">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </Card>
  );
}

function DailyChart({ data }: { data: DailyBucket[] }) {
  const max = Math.max(1, ...data.map((d) => d.ms));
  return (
    <div className="flex h-32 items-end gap-1.5">
      {data.map((d) => {
        const h = Math.max(2, (d.ms / max) * 100);
        const has = d.ms > 0;
        return (
          <div
            key={d.day}
            className="group flex flex-1 flex-col items-center gap-1"
            title={`${d.day} · ${formatTotal(d.ms)}`}
          >
            <div
              className={`w-full rounded-md transition-all ${has ? "bg-brand-gradient" : "bg-surface-3"}`}
              style={{ height: `${h}%` }}
            />
            <span className="text-[9px] text-muted">{d.day.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function SentimentBars({ data }: { data: Record<Sentiment, number> }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;
  const items: { key: Sentiment; color: string; label: string }[] = [
    { key: "positive", color: "bg-emerald-500", label: "Positive" },
    { key: "neutral", color: "bg-zinc-400", label: "Neutral" },
    { key: "mixed", color: "bg-amber-500", label: "Mixed" },
    { key: "negative", color: "bg-rose-500", label: "Negative" },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {items.map((it) =>
          data[it.key] > 0 ? (
            <div
              key={it.key}
              className={it.color}
              style={{ width: `${(data[it.key] / total) * 100}%` }}
              title={`${it.label}: ${data[it.key]}`}
            />
          ) : null,
        )}
      </div>
      <ul className="flex flex-wrap gap-3 text-xs">
        {items.map((it) => (
          <li key={it.key} className="inline-flex items-center gap-1.5 text-text-subtle">
            <span className={`inline-block h-2 w-2 rounded-full ${it.color}`} />
            {it.label}
            <span className="text-muted">{data[it.key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function computeInsights(sessions: ReturnType<typeof useSessions>["sessions"]) {
  const totalMs = sessions.reduce((a, s) => a + s.durationMs, 0);
  const avgMs = totalMs / Math.max(1, sessions.length);

  const languages = new Set(sessions.map((s) => s.language));

  const sentimentCounts: Record<Sentiment, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0,
  };
  for (const s of sessions) {
    if (s.summary) sentimentCounts[s.summary.sentiment]++;
  }
  const dominantSentiment =
    (Object.entries(sentimentCounts).sort(
      ([, a], [, b]) => b - a,
    )[0]?.[0] as Sentiment) ?? "neutral";

  // Daily buckets — 14 days
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daily: DailyBucket[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    daily.push({ day: d.toISOString().slice(0, 10), ms: 0 });
  }
  const idx = new Map(daily.map((d, i) => [d.day, i]));
  let thisWeek = 0;
  for (const s of sessions) {
    const day = s.createdAt.slice(0, 10);
    const i = idx.get(day);
    if (i !== undefined) {
      daily[i]!.ms += s.durationMs;
      if (i >= 7) thisWeek += 1;
    }
  }

  // Top words (very rough)
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const seg of s.segments) {
      for (const raw of seg.text.toLowerCase().split(/[^a-zçğıöşü0-9]+/i)) {
        const w = raw.trim();
        if (!w || w.length < 4) continue;
        if (STOP_WORDS.has(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  }
  const topWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word, count]) => ({ word, count }));

  // Top tags
  const tagCounts = new Map<string, number>();
  for (const s of sessions) {
    for (const t of s.tags) tagCounts.set(t.label, (tagCounts.get(t.label) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return {
    totalMs,
    avgMs,
    languages,
    sentimentCounts,
    dominantSentiment,
    daily,
    thisWeek,
    topWords,
    topTags,
  };
}

function formatTotal(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}
