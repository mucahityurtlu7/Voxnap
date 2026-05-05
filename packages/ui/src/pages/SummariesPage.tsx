/**
 * SummariesPage — at-a-glance grid of every session's TL;DR.
 *
 * Same data as Sessions, but reorganised around the AI summary content.
 */
import { Link } from "react-router-dom";
import { Sparkles, ListChecks, ArrowUpRight } from "lucide-react";
import type { Sentiment, SpeakerColor } from "@voxnap/core";

import { useSessions } from "../hooks/useSessions.js";
import { Card } from "../components/ui/Card.js";
import { Badge } from "../components/ui/Badge.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { LinkButton } from "../components/ui/LinkButton.js";

const SENTIMENT_TONE: Record<Sentiment, "success" | "danger" | "warning" | "neutral"> = {
  positive: "success",
  negative: "danger",
  mixed: "warning",
  neutral: "neutral",
};

export function SummariesPage() {
  const { sessions } = useSessions();
  const withSummary = sessions.filter((s) => s.summary);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Summaries</h1>
        <p className="text-xs text-muted">
          Voxnap's AI distils every session into a TL;DR, highlights, decisions and questions.
        </p>
      </header>

      {withSummary.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-5 w-5" />}
          title="No summaries yet"
          description="Record a session, then let the live AI panel do its thing."
          action={
            <LinkButton to="/" variant="primary">
              Start a session
            </LinkButton>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {withSummary.map((s) => {
            const summary = s.summary!;
            return (
              <li key={s.id}>
                {/*
                  Whole card is the click target — matches SessionsPage.
                  Inner "Open session" affordance stays as a visual hint so
                  users know they're navigating, not expanding in-place.
                */}
                <Link
                  to={`/sessions/${s.id}`}
                  className="block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                  aria-label={`Open session: ${s.title}`}
                >
                  <Card className="group flex h-full flex-col p-4 transition-all hover:border-brand-500/40 hover:shadow-glow">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge tone="brand" icon={<Sparkles className="h-3 w-3" />}>
                        TL;DR
                      </Badge>
                      <Badge tone={SENTIMENT_TONE[summary.sentiment]}>
                        {summary.sentiment}
                      </Badge>
                      <span className="ml-auto font-mono text-[11px] text-muted">
                        {new Date(summary.generatedAt).toLocaleDateString()}
                      </span>
                    </div>

                    <p className="text-sm font-medium leading-relaxed text-text">
                      {summary.tldr}
                    </p>

                    <ul className="mt-3 flex flex-1 flex-col gap-1.5">
                      {summary.bullets.slice(0, 3).map((b, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-1.5 text-[12px] text-text-subtle"
                        >
                          <ListChecks className="mt-0.5 h-3 w-3 shrink-0 text-brand-500" />
                          <span className="line-clamp-2">{b}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-3 flex flex-wrap items-center gap-1">
                      {s.tags.map((t) => (
                        <Badge key={t.id} tone={(t.color ?? "neutral") as SpeakerColor}>
                          {t.label}
                        </Badge>
                      ))}
                    </div>

                    <span
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-500 transition-colors group-hover:text-brand-600"
                      aria-hidden
                    >
                      Open session
                      <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </span>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
