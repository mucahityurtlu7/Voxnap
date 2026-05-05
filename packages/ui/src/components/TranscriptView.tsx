import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import type { Speaker, TranscriptionSegment } from "@voxnap/core";

import { Avatar } from "./ui/Avatar.js";

export interface TranscriptViewProps {
  finals: TranscriptionSegment[];
  interim: TranscriptionSegment | null;
  speakers?: Speaker[];
  /** When true, show timestamps and speaker bubbles. Defaults to true. */
  rich?: boolean;
  className?: string;
  emptyMessage?: string;
}

/**
 * Streaming-friendly transcript renderer (Granola-style).
 *
 *   • Final segments render as time-stamped paragraph blocks.
 *   • Interim segment renders inline at the bottom with a blinking caret.
 *   • Auto-scrolls to bottom unless user scrolled up — then exposes a
 *     "jump to bottom" pill.
 */
export function TranscriptView({
  finals,
  interim,
  speakers = [],
  rich = true,
  className,
  emptyMessage,
}: TranscriptViewProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [stuck, setStuck] = useState(true);

  const speakerMap = useMemo(() => {
    const m = new Map<string, Speaker>();
    for (const s of speakers) m.set(s.id, s);
    return m;
  }, [speakers]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isStuck = distance < 32;
    stickToBottomRef.current = isStuck;
    setStuck(isStuck);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [finals, interim]);

  const isEmpty = finals.length === 0 && !interim;

  const goToBottom = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className={clsx("relative h-full w-full", className)}>
      <div
        ref={ref}
        onScroll={onScroll}
        className={clsx(
          "h-full w-full overflow-y-auto rounded-2xl border border-border bg-surface px-6 py-5",
          "text-[15px] leading-relaxed text-text",
        )}
      >
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="rounded-full bg-brand-gradient-soft p-3 text-brand-500">
              <span className="block h-2 w-2 animate-pulse rounded-full bg-brand-500" />
            </div>
            <p className="text-sm text-muted">
              {emptyMessage ?? "Press the mic to start. Your words appear here in real time."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {rich
              ? renderRich(finals, interim, speakerMap)
              : renderFlat(finals, interim)}
          </div>
        )}
      </div>

      {!stuck && (
        <button
          type="button"
          onClick={goToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text shadow-soft hover:bg-surface-3 animate-fade-in"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          Jump to live
        </button>
      )}
    </div>
  );
}

function fmtTs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function renderRich(
  finals: TranscriptionSegment[],
  interim: TranscriptionSegment | null,
  speakerMap: Map<string, Speaker>,
) {
  // Group consecutive segments by speaker into paragraph bubbles.
  const groups: { speakerId?: string; items: TranscriptionSegment[] }[] = [];
  for (const seg of finals) {
    const last = groups[groups.length - 1];
    if (last && last.speakerId === seg.speakerId) {
      last.items.push(seg);
    } else {
      groups.push({ speakerId: seg.speakerId, items: [seg] });
    }
  }

  return (
    <>
      {groups.map((g, gi) => {
        const speaker = g.speakerId ? speakerMap.get(g.speakerId) : undefined;
        const start = g.items[0]!.startMs;
        const text = g.items.map((s) => s.text).join(" ");
        return (
          <div key={gi} className="flex gap-3">
            <div className="flex w-12 shrink-0 flex-col items-end gap-1 pt-0.5">
              <span className="font-mono text-[11px] text-muted">{fmtTs(start)}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                {speaker ? (
                  <>
                    <Avatar label={speaker.label} color={speaker.color} size="xs" />
                    <span className="text-xs font-semibold text-text">{speaker.label}</span>
                  </>
                ) : (
                  <span className="text-xs font-semibold text-text-subtle">Speaker</span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words">{text}</p>
            </div>
          </div>
        );
      })}

      {interim && (
        <div className="flex gap-3 animate-fade-in">
          <div className="flex w-12 shrink-0 flex-col items-end gap-1 pt-0.5">
            <span className="font-mono text-[11px] text-brand-500">live</span>
          </div>
          <p className="vx-caret min-w-0 flex-1 italic text-muted">
            {interim.text}
          </p>
        </div>
      )}
    </>
  );
}

function renderFlat(
  finals: TranscriptionSegment[],
  interim: TranscriptionSegment | null,
) {
  return (
    <p className="whitespace-pre-wrap break-words">
      {finals.map((s) => (
        <span key={s.id} className="mr-1">
          {s.text}
        </span>
      ))}
      {interim && (
        <span className="vx-caret mr-1 italic text-muted">{interim.text}</span>
      )}
    </p>
  );
}
