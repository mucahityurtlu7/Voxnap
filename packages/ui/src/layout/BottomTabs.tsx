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
      aria-label="Primary"
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
                "relative flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium outline-none transition-colors",
                "focus-visible:bg-surface-3",
                isActive ? "text-brand-500" : "text-muted hover:text-text",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-brand-gradient"
                  />
                )}
                <Icon className="h-4 w-4" aria-hidden />
                <span>{t.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
