/**
 * ComputeStep — onboarding step for picking *where* whisper runs.
 *
 * Voxnap auto-detects the available compute accelerators (Apple Neural
 * Engine, NVIDIA GPU, Qualcomm Hexagon, …) on the user's machine. We
 * surface that detection up-front during onboarding so:
 *
 *   1. The user *knows* their NPU/GPU is being used (privacy + perf
 *      reassurance).
 *   2. They can opt in/out before they start recording.
 *
 * The actual UI is the shared `ComputeBackendPicker` so this step stays
 * visually consistent with `Settings → Model`.
 */
import { Wand2, Zap, CheckCircle2 } from "lucide-react";
import type { ComputeBackend } from "@voxnap/core";

import { Badge } from "../../components/ui/Badge.js";
import { ComputeBackendPicker } from "../../components/ComputeBackendPicker.js";
import { useAccelerators } from "../../hooks/useAccelerators.js";

export interface ComputeStepProps {
  value: ComputeBackend;
  onChange: (next: ComputeBackend) => void;
}

export function ComputeStep({ value, onChange }: ComputeStepProps) {
  const { detected, loading } = useAccelerators();

  return (
    <div className="flex flex-col gap-3">
      {/* Headline detection badge so the user immediately sees Voxnap
          recognised their hardware (or fell back to CPU). */}
      <div className="flex items-start gap-2.5 rounded-xl border border-brand-500/40 bg-brand-gradient-soft p-3">
        {detected ? (
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        ) : (
          <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        )}
        <div className="min-w-0 text-xs">
          <div className="text-sm font-medium text-text">
            {loading
              ? "Looking for compute accelerators…"
              : detected
                ? `Detected: ${detected.label}`
                : "No NPU or GPU detected"}
          </div>
          <p className="mt-0.5 text-text-subtle">
            {loading
              ? "We're checking what your device offers."
              : detected
                ? "With Auto selected, Voxnap will run language models on this accelerator for the lowest latency and best privacy."
                : "Voxnap will fall back to CPU. Recordings still stay fully on-device — they're just a bit slower than on dedicated AI hardware."}
          </p>
          {detected && (
            <Badge
              tone="success"
              size="sm"
              icon={<CheckCircle2 className="h-2.5 w-2.5" />}
              className="mt-2"
            >
              On-device acceleration available
            </Badge>
          )}
        </div>
      </div>

      <ComputeBackendPicker value={value} onChange={onChange} hideHeader />

      <p className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-subtle">
        You can revisit this any time from{" "}
        <span className="font-medium text-text">Settings → Model</span>. Audio
        and transcripts always stay on this device unless you choose a cloud
        AI provider in the next step.
      </p>
    </div>
  );
}
