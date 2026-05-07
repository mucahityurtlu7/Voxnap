/**
 * ComputeBackendPicker — UI for selecting where whisper.cpp runs.
 *
 * Shared between the **Settings → Model** section and the **onboarding
 * Compute step** so the two surfaces always stay visually in sync.
 *
 * Behaviour:
 *   • Always shows an `Auto (recommended)` row at the top, with a small
 *     rosette telling the user which accelerator Auto would pick (e.g.
 *     "Apple Neural Engine") so the choice doesn't feel mysterious.
 *   • Lists every detected accelerator from `useAccelerators()`.
 *     Unavailable rows are clickable but visually muted and show their
 *     `unavailableReason` so the user can act on it (rebuild flag, OS
 *     unsupported, etc.). Clicking one still pins the preference because
 *     the Auto fallback will keep things working today.
 *   • Honours `disabled` (e.g. while a recording is in progress).
 */
import { useMemo } from "react";
import clsx from "clsx";
import {
  Cpu,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Wand2,
} from "lucide-react";
import type { AcceleratorInfo, ComputeBackend } from "@voxnap/core";

import { Badge } from "./ui/Badge.js";
import { useAccelerators } from "../hooks/useAccelerators.js";

export interface ComputeBackendPickerProps {
  /** User's stored preference (`"auto" | "npu" | "gpu" | "cpu"`). */
  value: ComputeBackend;
  onChange: (next: ComputeBackend) => void;
  /** Disable interaction (e.g. during an active recording). */
  disabled?: boolean;
  /** Hide the explanatory header — Settings already has section chrome. */
  hideHeader?: boolean;
  className?: string;
}

const ICON_FOR: Record<"auto" | "npu" | "gpu" | "cpu", typeof Cpu> = {
  auto: Wand2,
  npu: Zap,
  gpu: Sparkles,
  cpu: Cpu,
};

const FRIENDLY: Record<"auto" | "npu" | "gpu" | "cpu", string> = {
  auto: "Auto",
  npu: "NPU",
  gpu: "GPU",
  cpu: "CPU",
};

export function ComputeBackendPicker({
  value,
  onChange,
  disabled,
  hideHeader,
  className,
}: ComputeBackendPickerProps) {
  const { accelerators, detected, loading, error } = useAccelerators();

  const autoTarget = useMemo<AcceleratorInfo | null>(() => {
    // What "Auto" would actually run on, given current detection.
    const available = accelerators.filter((a) => a.available);
    return (
      available.find((a) => a.id === "npu") ??
      available.find((a) => a.id === "gpu") ??
      available.find((a) => a.id === "cpu") ??
      null
    );
  }, [accelerators]);

  return (
    <div className={clsx("flex flex-col gap-2.5", className)}>
      {!hideHeader && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-2.5">
          <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
          <div className="min-w-0 text-xs text-text-subtle">
            <div className="text-sm font-medium text-text">
              Where should models run?
            </div>
            <p className="mt-0.5">
              Voxnap auto-detects compute accelerators on your machine. Stick
              with <span className="font-medium text-text">Auto</span> unless
              you're debugging — it picks the fastest backend that's actually
              available right now.
            </p>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-text-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />
          Detecting available accelerators…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          Couldn't query accelerators: {error}. Falling back to CPU.
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <BackendRow
          id="auto"
          label="Auto (recommended)"
          description={
            autoTarget
              ? `Will run on ${autoTarget.label}.`
              : "Will run on CPU."
          }
          available
          selected={value === "auto"}
          onSelect={() => onChange("auto")}
          disabled={disabled}
          highlight={!!detected}
        />

        {accelerators.map((a) => {
          const isSelected = value === a.id;
          return (
            <BackendRow
              key={`${a.id}-${a.backend}`}
              id={a.id}
              label={a.label}
              description={
                a.available
                  ? a.vendor
                    ? `${a.vendor} · ${a.backend}`
                    : a.backend
                  : (a.unavailableReason ??
                    "Not available on this build of Voxnap.")
              }
              available={a.available}
              selected={isSelected}
              onSelect={() => onChange(a.id)}
              disabled={disabled}
              vendor={a.vendor}
            />
          );
        })}
      </div>
    </div>
  );
}

interface BackendRowProps {
  id: "auto" | "npu" | "gpu" | "cpu";
  label: string;
  description?: string;
  available: boolean;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** When true, draw an extra "detected" rosette (used on the Auto row). */
  highlight?: boolean;
  vendor?: string;
}

function BackendRow({
  id,
  label,
  description,
  available,
  selected,
  onSelect,
  disabled,
  highlight,
  vendor,
}: BackendRowProps) {
  const Icon = ICON_FOR[id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      disabled={disabled}
      className={clsx(
        "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
        selected
          ? "border-brand-500 bg-brand-gradient-soft"
          : "border-border bg-surface-2 hover:border-brand-500/40",
        !available && "opacity-70",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <div
        className={clsx(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          selected
            ? "bg-brand-gradient text-white shadow-glow"
            : available
              ? "bg-surface-3 text-text"
              : "bg-surface-3 text-muted",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={clsx(
              "text-sm font-medium",
              available ? "text-text" : "text-text-subtle",
            )}
          >
            {label}
          </span>
          {id !== "auto" && (
            <Badge tone={available ? "neutral" : "neutral"} size="sm">
              {FRIENDLY[id]}
            </Badge>
          )}
          {highlight && id === "auto" && (
            <Badge tone="success" size="sm" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>
              NPU/GPU detected
            </Badge>
          )}
          {!available && id !== "auto" && (
            <Badge tone="warning" size="sm" icon={<AlertTriangle className="h-2.5 w-2.5" />}>
              Not bundled
            </Badge>
          )}
          {vendor && id !== "auto" && (
            <span className="ml-auto text-[10px] uppercase tracking-wider text-muted">
              {vendor}
            </span>
          )}
        </div>
        {description && (
          <div className="mt-0.5 text-xs text-text-subtle">
            {description}
          </div>
        )}
      </div>

      <span
        className={clsx(
          "ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
          selected
            ? "border-brand-500 bg-brand-500 text-white"
            : "border-border bg-surface text-transparent",
        )}
        aria-hidden
      >
        {selected && <CheckCircle2 className="h-3.5 w-3.5" />}
      </span>
    </button>
  );
}
