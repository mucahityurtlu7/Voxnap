/**
 * Sidebar — primary navigation on `lg+` viewports.
 *
 * Collapsible into an icon-only rail to maximise transcript real estate.
 * Recents come from the live sessions store, not hardcoded fixtures.
 */
import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import clsx from "clsx";
import {
  ChevronsLeft,
  ChevronsRight,
  Mic,
  Library,
  Sparkles,
  BarChart3,
  Settings as SettingsIcon,
  Star,
  type LucideIcon,
} from "lucide-react";

import { Tooltip } from "../components/ui/Tooltip.js";
import { useSessions } from "../hooks/useSessions.js";

interface NavItemDef {
  to: string;
  end?: boolean;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

const NAV: NavItemDef[] = [
  { to: "/", end: true, label: "Live", icon: Mic },
  { to: "/sessions", label: "Sessions", icon: Library },
  { to: "/summaries", label: "Summaries", icon: Sparkles },
  { to: "/insights", label: "Insights", icon: BarChart3 },
];

export interface SidebarProps {
  /** Status pill rendered at the bottom (e.g. engine state). */
  statusLabel?: string;
  statusTone?: "ready" | "running" | "loading" | "error" | "idle";
}

const TONE_DOT: Record<NonNullable<SidebarProps["statusTone"]>, string> = {
  ready: "bg-emerald-500",
  running: "bg-rose-500 animate-pulse",
  loading: "bg-amber-500 animate-pulse",
  error: "bg-rose-500",
  idle: "bg-zinc-400",
};

export function Sidebar({ statusLabel = "Ready", statusTone = "ready" }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      aria-label="Primary"
      className={clsx(
        "hidden lg:flex h-full flex-col border-r border-border bg-surface/80 backdrop-blur-sm",
        "transition-[width] duration-200 ease-out",
        collapsed ? "w-[68px]" : "w-[232px]",
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-glow"
          aria-hidden
        >
          <Mic className="h-3.5 w-3.5" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="vx-gradient-text text-sm font-semibold tracking-tight">
              Voxnap
            </div>
            <div className="text-[10px] text-muted">Privacy-first transcription</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Sections">
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavItem item={item} collapsed={collapsed} />
            </li>
          ))}
        </ul>

        {!collapsed && <RecentList />}
      </nav>

      {/* Status + collapse */}
      <div className="border-t border-border p-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            clsx(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-brand-500/40",
              isActive
                ? "bg-surface-3 text-text"
                : "text-text-subtle hover:bg-surface-3 hover:text-text",
            )
          }
        >
          <SettingsIcon className="h-4 w-4" aria-hidden />
          {!collapsed && <span>Settings</span>}
        </NavLink>

        <div
          role="status"
          aria-label={`Engine status: ${statusLabel}`}
          className={clsx(
            "mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted",
            "border border-border bg-surface-2",
          )}
        >
          <span
            className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[statusTone])}
            aria-hidden
          />
          {!collapsed && <span className="truncate">{statusLabel}</span>}
        </div>

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={clsx(
            "mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted outline-none",
            "hover:bg-surface-3 hover:text-text",
            "focus-visible:ring-2 focus-visible:ring-brand-500/40",
          )}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" aria-hidden />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" aria-hidden />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function NavItem({ item, collapsed }: { item: NavItemDef; collapsed: boolean }) {
  const Icon = item.icon;
  const inner = (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        clsx(
          "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-brand-500/40",
          isActive
            ? "bg-brand-gradient-soft text-text shadow-soft"
            : "text-text-subtle hover:bg-surface-3 hover:text-text",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute -left-1 top-1/2 h-5 -translate-y-1/2 rounded-r-full bg-brand-500 w-0.5"
            />
          )}
          <Icon
            className={clsx("h-4 w-4 shrink-0", isActive && "text-brand-500")}
            aria-hidden
          />
          {!collapsed && <span className="truncate">{item.label}</span>}
          {!collapsed && item.badge && (
            <span className="ml-auto rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
  return collapsed ? <Tooltip content={item.label} side="bottom">{inner}</Tooltip> : inner;
}

/**
 * Pulls the 5 most recent sessions from the sessions store. Falls back to
 * a quiet empty state when the user hasn't recorded anything yet, instead
 * of inventing fake links.
 */
function RecentList() {
  const { sessions } = useSessions();
  const recents = useMemo(() => {
    return [...sessions]
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, 5);
  }, [sessions]);

  if (recents.length === 0) return null;

  return (
    <div className="mt-6 px-2">
      <div className="vx-eyebrow mb-2">Recent</div>
      <ul className="flex flex-col gap-0.5">
        {recents.map((s) => (
          <li key={s.id}>
            <NavLink
              to={`/sessions/${s.id}`}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-brand-500/40",
                  isActive ? "bg-surface-3 text-text" : "text-muted hover:bg-surface-3 hover:text-text",
                )
              }
            >
              {s.starred ? (
                <Star className="h-3 w-3 shrink-0 fill-amber-500 text-amber-500" aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 shrink-0 rounded-full bg-brand-500/60"
                />
              )}
              <span className="truncate">{s.title}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
