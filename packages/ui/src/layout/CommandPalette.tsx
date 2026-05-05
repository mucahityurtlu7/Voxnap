/**
 * CommandPalette — ⌘K menu, Linear-flavoured.
 *
 * Lists pages, recent sessions and quick actions. Pure client-side filter,
 * no fuzzy lib needed. Active row is kept in view via `scrollIntoView`,
 * which matters when keyboard-only users blow past the visible window.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Mic,
  Library,
  Sparkles,
  BarChart3,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
  Star,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";

import { useSessions } from "../hooks/useSessions.js";
import { useTheme } from "../hooks/useTheme.js";
import { Kbd } from "../components/ui/Kbd.js";
import { Shortcut } from "../components/ui/Shortcut.js";
import { Dialog } from "../components/ui/Dialog.js";

interface PaletteItem {
  id: string;
  group: "Pages" | "Sessions" | "Theme" | "Actions";
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional callback to start/stop recording from the palette. */
  onToggleRecording?: () => void;
  recording?: boolean;
}

export function CommandPalette({
  open,
  onOpenChange,
  onToggleRecording,
  recording,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { sessions } = useSessions();
  const { setMode } = useTheme();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset query when reopening; focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const close = () => onOpenChange(false);
    const navTo = (to: string) => () => {
      navigate(to);
      close();
    };

    const pages: PaletteItem[] = [
      { id: "p:live", group: "Pages", label: "Go to Live", icon: Mic, run: navTo("/"), hint: "Home" },
      { id: "p:sessions", group: "Pages", label: "Go to Sessions", icon: Library, run: navTo("/sessions") },
      { id: "p:summaries", group: "Pages", label: "Go to Summaries", icon: Sparkles, run: navTo("/summaries") },
      { id: "p:insights", group: "Pages", label: "Go to Insights", icon: BarChart3, run: navTo("/insights") },
      { id: "p:settings", group: "Pages", label: "Go to Settings", icon: SettingsIcon, run: navTo("/settings"), hint: "mod+," },
    ];

    const actions: PaletteItem[] = [];
    if (onToggleRecording) {
      actions.push({
        id: "a:record",
        group: "Actions",
        label: recording ? "Stop recording" : "Start new recording",
        icon: Mic,
        run: () => {
          onToggleRecording();
          close();
        },
        hint: "mod+.",
      });
    }

    const themes: PaletteItem[] = [
      { id: "t:system", group: "Theme", label: "Theme · System", icon: Monitor, run: () => { setMode("system"); close(); } },
      { id: "t:light", group: "Theme", label: "Theme · Light", icon: Sun, run: () => { setMode("light"); close(); } },
      { id: "t:dark", group: "Theme", label: "Theme · Dark", icon: Moon, run: () => { setMode("dark"); close(); } },
    ];

    const sessionItems: PaletteItem[] = sessions.slice(0, 8).map((s) => ({
      id: `s:${s.id}`,
      group: "Sessions",
      label: s.title,
      hint: new Date(s.createdAt).toLocaleDateString(),
      icon: s.starred ? Star : ArrowUpRight,
      run: navTo(`/sessions/${s.id}`),
    }));

    return [...pages, ...actions, ...sessionItems, ...themes];
  }, [navigate, onOpenChange, sessions, setMode, onToggleRecording, recording]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Group preserving order of `filtered`.
  const grouped = useMemo(() => {
    const groups: { name: PaletteItem["group"]; items: PaletteItem[] }[] = [];
    for (const item of filtered) {
      let g = groups.find((x) => x.name === item.group);
      if (!g) {
        g = { name: item.group, items: [] };
        groups.push(g);
      }
      g.items.push(item);
    }
    return groups;
  }, [filtered]);

  // Keep the active row visible after keyboard navigation.
  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-idx="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[active]?.run();
    }
  };

  const flatIndex = (groupIndex: number, itemIndex: number) => {
    let i = 0;
    for (let g = 0; g < groupIndex; g++) i += grouped[g]!.items.length;
    return i + itemIndex;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-xl">
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search…"
            aria-label="Command palette search"
            role="combobox"
            aria-expanded
            aria-controls="vx-cmd-list"
            aria-activedescendant={filtered[active]?.id}
            className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div
          ref={listRef}
          id="vx-cmd-list"
          role="listbox"
          aria-label="Commands"
          className="max-h-[60vh] overflow-y-auto p-2"
        >
          {grouped.length === 0 && (
            <NoMatches query={query} />
          )}
          {grouped.map((g, gi) => (
            <div key={g.name} className="mb-2 last:mb-0">
              <div className="vx-eyebrow px-3 pb-1 pt-2">{g.name}</div>
              <ul>
                {g.items.map((item, ii) => {
                  const idx = flatIndex(gi, ii);
                  const isActive = idx === active;
                  const Icon = item.icon;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        id={item.id}
                        role="option"
                        aria-selected={isActive}
                        data-cmd-idx={idx}
                        onMouseEnter={() => setActive(idx)}
                        onClick={item.run}
                        className={clsx(
                          "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none",
                          isActive
                            ? "bg-brand-gradient-soft text-text"
                            : "text-text-subtle hover:bg-surface-3 hover:text-text",
                        )}
                      >
                        <Icon
                          className={clsx(
                            "h-4 w-4 shrink-0",
                            isActive ? "text-brand-500" : "text-muted",
                          )}
                          aria-hidden
                        />
                        <span className="flex-1 truncate text-left">{item.label}</span>
                        {renderHint(item.hint)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-surface-2 px-4 py-2 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>Navigate</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            <span>Open</span>
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Shortcut keys="mod+k" variant="compact" />
            <span>Toggle</span>
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function renderHint(hint?: string): ReactNode {
  if (!hint) return null;
  if (hint.includes("+")) {
    return <Shortcut keys={hint} variant="compact" />;
  }
  return <span className="text-[11px] text-muted">{hint}</span>;
}

function NoMatches({ query }: { query: string }) {
  return (
    <div className="px-3 py-10 text-center">
      <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-surface-3 text-muted">
        <Library className="h-4 w-4" aria-hidden />
      </div>
      <div className="text-sm font-medium text-text">No matches</div>
      <div className="mt-1 text-xs text-muted">
        {query
          ? <>No commands match <span className="text-text">“{query}”</span>.</>
          : "Start typing to search commands."}
      </div>
    </div>
  );
}
