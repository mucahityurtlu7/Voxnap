/**
 * BottomTabs — primary navigation on small viewports.
 *
 * Mirrors the Sidebar items but lives at the bottom edge (with safe-area
 * inset for Tauri Mobile / iOS).
 */
import { NavLink } from "react-router-dom";
import clsx from "clsx";
import { Mic, Library, Sparkles, BarChart3, Settings } from "lucide-react";

const TABS = [
  { to: "/", end: true, label: "Live", icon: Mic },
  { to: "/sessions", label: "Sessions", icon: Library },
  { to: "/summaries", label: "Summaries", icon: Sparkles },
  { to: "/insights", label: "Insights", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function BottomTabs() {
  return (
    <nav
      className={clsx(
        "lg:hidden safe-bottom sticky bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface/95 backdrop-blur-md",
      )}
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              clsx(
                "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium",
                isActive ? "text-brand-500" : "text-muted hover:text-text",
              )
            }
          >
            <Icon className="h-4 w-4" />
            {t.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
