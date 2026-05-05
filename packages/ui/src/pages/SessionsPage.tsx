/**
 * SessionsPage — searchable, filterable list of saved sessions.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Star,
  Trash2,
  Clock,
  Languages,
  Sparkles,
  Library,
  Plus,
} from "lucide-react";
import clsx from "clsx";
import type { Session, SpeakerColor } from "@voxnap/core";

import { useSessions } from "../hooks/useSessions.js";
import { SearchInput } from "../components/ui/SearchInput.js";
import { Badge } from "../components/ui/Badge.js";
import { LinkButton } from "../components/ui/LinkButton.js";
import { Avatar } from "../components/ui/Avatar.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Card } from "../components/ui/Card.js";

type Filter = "all" | "starred" | "today" | "this-week";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "starred", label: "Starred" },
  { id: "today", label: "Today" },
  { id: "this-week", label: "This week" },
];

export function SessionsPage() {
  const { sessions, toggleStar, remove } = useSessions();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return sessions.filter((s) => {
      if (filter === "starred" && !s.starred) return false;
      if (filter === "today") {
        const same = new Date(s.createdAt).toDateString() === new Date().toDateString();
        if (!same) return false;
      }
      if (filter === "this-week") {
        const diff = now - new Date(s.createdAt).getTime();
        if (diff > 7 * 24 * 60 * 60 * 1000) return false;
      }
      if (!q) return true;
      const hay = [
        s.title,
        s.summary?.tldr,
        ...s.tags.map((t) => t.label),
        ...(s.summary?.bullets ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, query, filter]);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Sessions</h1>
          <p className="text-xs text-muted">
            Everything you've recorded. Searchable, taggable, exportable.
          </p>
        </div>
        <LinkButton
          to="/"
          variant="primary"
          leftIcon={<Plus className="h-4 w-4" aria-hidden />}
        >
          New session
        </LinkButton>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          placeholder="Search by title, tag or content…"
          className="max-w-xl"
        />
        <div
          role="tablist"
          aria-label="Filter sessions"
          className="flex flex-1 flex-wrap items-center gap-1.5"
        >
          {FILTERS.map((f) => {
            const selected = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setFilter(f.id)}
                className={clsx(
                  "rounded-full border px-3 py-1 text-xs font-medium outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-brand-500/40",
                  selected
                    ? "border-brand-500 bg-brand-gradient-soft text-text"
                    : "border-border bg-surface-2 text-text-subtle hover:bg-surface-3 hover:text-text",
                )}
              >
                {f.label}
              </button>
            );
          })}
          <span
            className="ml-auto text-xs tabular-nums text-muted"
            aria-live="polite"
          >
            {filtered.length} of {sessions.length}
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Library className="h-5 w-5" />}
          title={sessions.length === 0 ? "No sessions yet" : "No matches"}
          description={
            sessions.length === 0
              ? "Hit the mic on the Live page to capture your first session."
              : "Try a different search or filter."
          }
          action={
            sessions.length === 0 ? (
              <LinkButton to="/" variant="primary">
                Start recording
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => (
            <li key={s.id}>
              <SessionCard
                session={s}
                onStar={() => void toggleStar(s.id)}
                onDelete={() => void remove(s.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CardProps {
  session: Session;
  onStar: () => void;
  onDelete: () => void;
}

function SessionCard({ session, onStar, onDelete }: CardProps) {
  return (
    <Card className="group flex h-full flex-col overflow-hidden transition-all hover:border-brand-500/40 hover:shadow-glow">
      <Link to={`/sessions/${session.id}`} className="block flex-1 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted">
            {formatRelativeDate(session.createdAt)}
          </span>
          <span className="text-muted">·</span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted">
            <Clock className="h-3 w-3" />
            {formatDuration(session.durationMs)}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
            <Languages className="h-3 w-3" />
            {session.language}
          </span>
        </div>

        <h3 className="line-clamp-2 text-sm font-semibold text-text">
          {session.title}
        </h3>

        {session.summary?.tldr && (
          <p className="mt-1 line-clamp-2 text-xs text-muted">
            {session.summary.tldr}
          </p>
        )}

        {session.summary?.bullets && session.summary.bullets.length > 0 && (
          <ul className="mt-3 space-y-1">
            {session.summary.bullets.slice(0, 2).map((b, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 text-[11px] text-text-subtle"
              >
                <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-brand-500" />
                <span className="line-clamp-2">{b}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1">
          {session.tags.map((t) => (
            <Badge key={t.id} tone={(t.color ?? "neutral") as SpeakerColor}>
              {t.label}
            </Badge>
          ))}
          {session.actionItems.length > 0 && (
            <Badge tone="warning">{session.actionItems.length} actions</Badge>
          )}
        </div>

        <div className="mt-3 flex items-center gap-1">
          {session.speakers.slice(0, 4).map((sp) => (
            <Avatar key={sp.id} label={sp.label} color={sp.color} size="xs" />
          ))}
          {session.speakers.length > 4 && (
            <span className="text-[10px] text-muted">
              +{session.speakers.length - 4}
            </span>
          )}
        </div>
      </Link>

      {/*
        Action row: visible on touch (no hover), fades in on hover for
        pointer devices. Keeps the card discoverable on mobile while
        staying out of the way on desktop until needed.
      */}
      <div
        className={clsx(
          "flex items-center justify-end gap-1 border-t border-border bg-surface-2 px-3 py-2",
          "transition-opacity",
          "opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100",
        )}
      >
        <button
          type="button"
          aria-label={session.starred ? "Remove star" : "Star session"}
          aria-pressed={session.starred}
          onClick={(e) => {
            e.preventDefault();
            onStar();
          }}
          className={clsx(
            "flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors",
            "hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-brand-500/40",
            session.starred ? "text-amber-500" : "text-muted",
          )}
        >
          <Star
            className={clsx("h-3.5 w-3.5", session.starred && "fill-amber-500")}
            aria-hidden
          />
        </button>
        <button
          type="button"
          aria-label="Delete session"
          onClick={(e) => {
            e.preventDefault();
            if (confirm(`Delete "${session.title}"? This can't be undone.`)) onDelete();
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-rose-500/10 hover:text-rose-500 focus-visible:ring-2 focus-visible:ring-rose-500/40"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </Card>
  );
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
