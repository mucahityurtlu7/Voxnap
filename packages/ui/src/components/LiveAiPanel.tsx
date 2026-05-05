/**
 * LiveAiPanel — streaming TL;DR + bullets + action items + chapters.
 *
 * Driven by `useLiveAi`, which wraps any ISummarizer (defaults to mock).
 * Empty / thinking / ready states each have their own visual.
 */
import {
  CheckCircle2,
  Sparkles,
  ListChecks,
  HelpCircle,
  Bookmark,
  Wand2,
} from "lucide-react";
import clsx from "clsx";

import { Skeleton } from "./ui/Skeleton.js";
import type { ActionItem, Chapter } from "@voxnap/core";

export interface LiveAiPanelProps {
  status: "idle" | "thinking" | "ready" | "error";
  tldr: string;
  bullets: string[];
  decisions: string[];
  questions: string[];
  actionItems: ActionItem[];
  chapters: Chapter[];
  onSeek?: (ms: number) => void;
  onRegenerate?: () => void;
  className?: string;
}

export function LiveAiPanel({
  status,
  tldr,
  bullets,
  decisions,
  questions,
  actionItems,
  chapters,
  onSeek,
  onRegenerate,
  className,
}: LiveAiPanelProps) {
  const isEmpty =
    !tldr &&
    bullets.length === 0 &&
    decisions.length === 0 &&
    questions.length === 0 &&
    actionItems.length === 0;

  return (
    <aside
      className={clsx(
        "flex h-full min-h-0 flex-col rounded-2xl border border-border bg-surface",
        className,
      )}
    >
      <header className="flex items-center justify-between border-b border-border bg-panel-glow px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-glow">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div>
            <div className="text-sm font-semibold text-text">Live AI</div>
            <div className="text-[10px] text-muted">
              {status === "thinking" && "Thinking…"}
              {status === "ready" && "Up to date"}
              {status === "idle" && "Waiting for words"}
              {status === "error" && "Something went sideways"}
            </div>
          </div>
        </div>

        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-subtle hover:bg-surface-3 hover:text-text"
          >
            <Wand2 className="h-3 w-3" />
            Regenerate
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isEmpty && status === "idle" && (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted">
            <Sparkles className="mb-2 h-5 w-5" />
            <p className="text-xs">
              Start speaking. A live summary will materialise here.
            </p>
          </div>
        )}

        {/* TL;DR */}
        {(tldr || status === "thinking") && (
          <Block icon={<Sparkles className="h-3.5 w-3.5" />} label="TL;DR">
            {tldr ? (
              <p className="text-sm font-medium leading-relaxed text-text">
                {tldr}
              </p>
            ) : (
              <Skeleton className="h-4 w-3/4" />
            )}
          </Block>
        )}

        {/* Bullets */}
        {(bullets.length > 0 || status === "thinking") && (
          <Block icon={<ListChecks className="h-3.5 w-3.5" />} label="Highlights">
            <ul className="flex flex-col gap-1.5">
              {bullets.map((b, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-text-subtle animate-fade-in"
                >
                  <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                  <span className="min-w-0">{b}</span>
                </li>
              ))}
              {status === "thinking" && bullets.length < 3 && (
                <>
                  <Skeleton className="h-3 w-11/12" />
                  <Skeleton className="h-3 w-9/12" />
                </>
              )}
            </ul>
          </Block>
        )}

        {/* Action items */}
        {actionItems.length > 0 && (
          <Block icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Action items">
            <ul className="flex flex-col gap-1.5">
              {actionItems.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2 text-xs animate-fade-in"
                >
                  <input
                    type="checkbox"
                    defaultChecked={a.done}
                    className="mt-0.5 h-3.5 w-3.5 accent-brand-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-text">{a.text}</span>
                    {a.owner && (
                      <span className="ml-1 text-muted">· {a.owner}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {/* Decisions */}
        {decisions.length > 0 && (
          <Block icon={<Bookmark className="h-3.5 w-3.5" />} label="Decisions">
            <ul className="flex flex-col gap-1.5 text-sm text-text-subtle">
              {decisions.map((d, i) => (
                <li key={i} className="flex items-start gap-2 animate-fade-in">
                  <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {/* Questions */}
        {questions.length > 0 && (
          <Block icon={<HelpCircle className="h-3.5 w-3.5" />} label="Open questions">
            <ul className="flex flex-col gap-1.5 text-sm text-text-subtle">
              {questions.map((q, i) => (
                <li key={i} className="flex items-start gap-2 animate-fade-in">
                  <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {/* Chapters */}
        {chapters.length > 0 && (
          <Block label="Chapters">
            <ol className="flex flex-col gap-1.5">
              {chapters.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSeek?.(c.startMs)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-subtle transition-colors hover:bg-surface-3 hover:text-text"
                  >
                    <span className="font-mono text-muted">
                      {formatMs(c.startMs)}
                    </span>
                    <span className="truncate">{c.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Block>
        )}
      </div>
    </aside>
  );
}

function Block({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <div className="vx-eyebrow mb-2 flex items-center gap-1.5">
        {icon && <span className="text-brand-500">{icon}</span>}
        {label}
      </div>
      {children}
    </section>
  );
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
