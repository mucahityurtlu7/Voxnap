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
 *   • Exposes a "Diagnose NPU" link that opens a modal with the verbose
 *     diagnostic from `engine.diagnoseAccelerators()`. This is the
 *     *user-facing answer* to "I have an NPU but Voxnap won't use it":
 *     the modal walks through compile-features, EP probes, and PnP scan
 *     results and surfaces the underlying error string from each step.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  Cpu,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Wand2,
  XCircle,
  Info,
  Stethoscope,
  RefreshCcw,
  X,
} from "lucide-react";
import type {
  AcceleratorInfo,
  ComputeBackend,
  DiagnosticEntry,
  DiagnosticReport,
  DiagnosticStatus,
} from "@voxnap/core";

import { Badge } from "./ui/Badge.js";
import { Button } from "./ui/Button.js";
import { Dialog } from "./ui/Dialog.js";
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
  const { accelerators, detected, loading, error, refresh, canDiagnose, diagnose } =
    useAccelerators();
  const [diagOpen, setDiagOpen] = useState(false);

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

  // Surface a "Diagnose" affordance whenever the engine supports it.
  // We *especially* want the user to find it when something is greyed
  // out — that's the whole point of the modal — but we keep it
  // available even in the happy path so they can confirm the NPU is
  // active without digging through logs.
  const hasGreyedRow = accelerators.some((a) => !a.available);
  const showDiagnose = canDiagnose;

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
              unavailableReason={a.unavailableReason}
            />
          );
        })}
      </div>

      {showDiagnose && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-subtle">
          <button
            type="button"
            onClick={() => setDiagOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-brand-500 hover:bg-brand-500/10 transition-colors"
          >
            <Stethoscope className="h-3.5 w-3.5" />
            Diagnose NPU / GPU detection
          </button>
          <button
            type="button"
            onClick={() => refresh()}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-surface-2 transition-colors"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Re-scan
          </button>
          {hasGreyedRow && (
            <span className="text-[11px] text-muted">
              Some accelerators are greyed out — diagnose to see why.
            </span>
          )}
        </div>
      )}

      <DiagnosticDialog
        open={diagOpen}
        onClose={() => setDiagOpen(false)}
        runDiagnose={diagnose}
      />
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
  /**
   * Raw `unavailableReason` from the engine. Drives the "Not bundled" vs
   * "Unavailable" badge split — see the badge block below for the rule.
   */
  unavailableReason?: string;
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
  unavailableReason,
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
            <Badge
              tone="warning"
              size="sm"
              icon={<AlertTriangle className="h-2.5 w-2.5" />}
              title={
                unavailableReason ??
                "This accelerator wasn't compiled into the current Voxnap build."
              }
            >
              {/*
               * Differentiate "not compiled in" from "compiled but the
               * runtime libraries / hardware aren't ready". Both end up
               * with `available: false`, but the user-facing fix is very
               * different (rebuild vs install vendor SDK), and the full
               * reason already shows up in the row description below.
               */}
              {unavailableReason?.startsWith("Rebuild")
                ? "Not bundled"
                : "Unavailable"}
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

// ---------------------------------------------------------------------------
// Diagnostic dialog
// ---------------------------------------------------------------------------

interface DiagnosticDialogProps {
  open: boolean;
  onClose: () => void;
  runDiagnose: () => Promise<DiagnosticReport | null>;
}

function DiagnosticDialog({ open, onClose, runDiagnose }: DiagnosticDialogProps) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const r = await runDiagnose();
      setReport(r);
    } finally {
      setLoading(false);
    }
  };

  // Lazy-load: only fire the diagnostic the first time the modal opens.
  // Otherwise opening Settings would shell out to PowerShell on every
  // render, which is wasteful and visible in `top`.
  if (open && !report && !loading) {
    void run();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <div className="flex items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text">
            Accelerator diagnostics
          </h2>
          <p className="mt-0.5 text-xs text-text-subtle">
            One row per detection channel: compile-time features, ONNX Runtime
            execution provider probes, and OS-level NPU device enumeration.
            If your NPU isn't showing up as available, the failing row will
            tell you exactly why.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-text-subtle hover:bg-surface-2 hover:text-text"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-text-subtle">
            <Loader2 className="h-4 w-4 animate-spin text-brand-500" />
            Running probes…
          </div>
        )}

        {!loading && report && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs">
              <div className="text-text-subtle">Platform</div>
              <div className="font-mono text-sm text-text">{report.platform}</div>
              <div className="mt-2 text-text-subtle">Compiled-in features</div>
              <div className="font-mono text-sm text-text">
                {report.compiledFeatures.length === 0
                  ? "(none — pure CPU build)"
                  : report.compiledFeatures.join(", ")}
              </div>
            </div>

            <ul className="space-y-2">
              {report.entries.map((e, i) => (
                <DiagnosticRow key={`${e.id}-${i}`} entry={e} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border p-3">
        <Button variant="ghost" size="sm" onClick={() => void run()} disabled={loading}>
          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
          Re-run probes
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

const STATUS_ICON: Record<DiagnosticStatus, typeof CheckCircle2> = {
  ok: CheckCircle2,
  failed: XCircle,
  skipped: Info,
  info: Info,
};

const STATUS_TONE: Record<DiagnosticStatus, string> = {
  ok: "text-emerald-500",
  failed: "text-rose-500",
  skipped: "text-muted",
  info: "text-brand-500",
};

function DiagnosticRow({ entry }: { entry: DiagnosticEntry }) {
  const Icon = STATUS_ICON[entry.status];
  return (
    <li className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-3">
      <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", STATUS_TONE[entry.status])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text">{entry.label}</span>
          <Badge
            tone={
              entry.status === "ok"
                ? "success"
                : entry.status === "failed"
                  ? "danger"
                  : "neutral"
            }
            size="sm"
          >
            {entry.status}
          </Badge>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted">
            {entry.id}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-xs text-text-subtle">
          {entry.detail}
        </p>
      </div>
    </li>
  );
}
