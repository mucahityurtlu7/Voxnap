/**
 * Sidebar — primary navigation on `lg+` viewports.
 *
 * Collapsible into an icon-only rail to maximise transcript real estate.
 */
import { useState } from "react";
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
  CircleDot,
  type LucideIcon,
} from "lucide-react";

import { Tooltip } from "../components/ui/Tooltip.js";

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
      className={clsx(
        "hidden lg:flex h-full flex-col border-r border-border bg-surface/80 backdrop-blur-sm",
        "transition-[width] duration-200 ease-out",
        collapsed ? "w-[68px]" : "w-[232px]",
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-glow">
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
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavItem item={item} collapsed={collapsed} />
            </li>
          ))}
        </ul>

        {!collapsed && (
          <div className="mt-6 px-2">
            <div className="vx-eyebrow mb-2">Recent</div>
            <RecentList />
          </div>
        )}
      </nav>

      {/* Status + collapse */}
      <div className="border-t border-border p-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            clsx(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
              isActive
                ? "bg-surface-3 text-text"
                : "text-text-subtle hover:bg-surface-3 hover:text-text",
            )
          }
        >
          <SettingsIcon className="h-4 w-4" />
          {!collapsed && <span>Settings</span>}
        </NavLink>

        <div
          className={clsx(
            "mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted",
            "border border-border bg-surface-2",
          )}
        >
          <span
            className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[statusTone])}
          />
          {!collapsed && (
            <span className="truncate">
              {statusLabel}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={clsx(
            "mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted",
            "hover:bg-surface-3 hover:text-text",
          )}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
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
          "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-brand-gradient-soft text-text shadow-soft"
            : "text-text-subtle hover:bg-surface-3 hover:text-text",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute -left-1 top-1/2 h-5 -translate-y-1/2 rounded-r-full bg-brand-500 w-0.5" />
          )}
          <Icon className={clsx("h-4 w-4 shrink-0", isActive && "text-brand-500")} />
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

function RecentList() {
  // Hard-coded recent picks; real session shortcuts come later via useSessions().
  const recents = [
    { id: "sess_design_review_v02", label: "Design review v0.2", color: "bg-brand-500" },
    { id: "sess_perf_huddle_tr", label: "Performans toplantısı", color: "bg-emerald-500" },
    { id: "sess_user_interview_kenji", label: "User interview", color: "bg-cyan-500" },
  ];
  return (
    <ul className="flex flex-col gap-0.5">
      {recents.map((r) => (
        <li key={r.id}>
          <NavLink
            to={`/sessions/${r.id}`}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                isActive ? "text-text" : "text-muted hover:text-text",
              )
            }
          >
            <CircleDot className={clsx("h-2.5 w-2.5 shrink-0", r.color, "rounded-full")} />
            <span className="truncate">{r.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
