/**
 * useAccelerators — fetch the compute accelerators (NPU / GPU / CPU) the
 * active engine can target on this host.
 *
 * Wraps `engine.listAccelerators()` with a one-shot lazy load + simple
 * cache so the Settings page and the onboarding `Compute` step can both
 * mount without each triggering its own IPC call. The list is small and
 * cheap to recompute, but talking to Rust through Tauri does involve a
 * round-trip we'd rather not pay twice on the same render.
 *
 * Returns:
 *   • `accelerators`    — every detected compute target
 *   • `available`       — convenience subset (just the usable ones)
 *   • `detected`        — best NPU/GPU we can use at runtime, if any
 *   • `loading`         — while the first call is still in flight
 *   • `error`           — string if the engine failed (not thrown — the
 *                         picker can still render a CPU-only fallback)
 *   • `refresh()`       — re-run detection (useful after a settings change
 *                         that might affect availability)
 *   • `diagnose()`      — call the engine's verbose diagnostic so the UI
 *                         can show *why* an NPU isn't lighting up. Returns
 *                         `null` when the active engine doesn't expose
 *                         the diagnostic API (Mock / WASM today).
 *   • `canDiagnose`     — `true` iff the active engine implements
 *                         `diagnoseAccelerators`. UI uses this to hide
 *                         the "Diagnose" button on engines that don't
 *                         support it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AcceleratorInfo,
  ComputeBackend,
  DiagnosticReport,
} from "@voxnap/core";

import { useEngine } from "../engine/EngineProvider.js";

const FALLBACK: AcceleratorInfo[] = [
  {
    id: "cpu",
    label: "CPU",
    backend: "cpu",
    available: true,
  },
];

export interface UseAcceleratorsApi {
  accelerators: AcceleratorInfo[];
  available: AcceleratorInfo[];
  /**
   * Best non-CPU accelerator the engine can actually use. `null` if the
   * host is CPU-only (no NPU/GPU detected, or all greyed out).
   */
  detected: AcceleratorInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** True iff the engine exposes `diagnoseAccelerators`. */
  canDiagnose: boolean;
  /**
   * Run the engine's verbose accelerator diagnostic. Resolves to `null`
   * when the active engine doesn't expose the API at all (Mock / WASM).
   */
  diagnose: () => Promise<DiagnosticReport | null>;
}

export function useAccelerators(): UseAcceleratorsApi {
  const engine = useEngine();
  const [accelerators, setAccelerators] = useState<AcceleratorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Older engines (or the mock) may not expose listAccelerators().
      // In that case we still want a sensible fallback so the UI
      // continues to render a Compute picker with at least CPU.
      if (typeof engine.listAccelerators !== "function") {
        setAccelerators(FALLBACK);
      } else {
        const list = await engine.listAccelerators();
        setAccelerators(list.length > 0 ? list : FALLBACK);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voxnap] listAccelerators failed:", err);
      setError((err as Error)?.message ?? "Failed to detect accelerators");
      setAccelerators(FALLBACK);
    } finally {
      setLoading(false);
    }
  }, [engine]);

  useEffect(() => {
    void load();
  }, [load]);

  const available = accelerators.filter((a) => a.available);

  // The "detected" highlight only makes sense for the actual hardware
  // accelerators (NPU/GPU). If only CPU is usable we don't make a fuss.
  const detected =
    available.find((a) => a.id === "npu") ??
    available.find((a) => a.id === "gpu") ??
    null;

  const canDiagnose = typeof engine.diagnoseAccelerators === "function";

  const diagnose = useCallback(async (): Promise<DiagnosticReport | null> => {
    if (typeof engine.diagnoseAccelerators !== "function") return null;
    try {
      return await engine.diagnoseAccelerators();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[voxnap] diagnoseAccelerators failed:", err);
      const message = (err as Error)?.message ?? String(err);
      return {
        platform: "unknown",
        compiledFeatures: [],
        entries: [
          {
            id: "diagnose-failed",
            label: "Diagnostic call failed",
            status: "failed",
            detail: message,
          },
        ],
      };
    }
  }, [engine]);

  return useMemo(
    () => ({
      accelerators,
      available,
      detected,
      loading,
      error,
      refresh: () => void load(),
      canDiagnose,
      diagnose,
    }),
    [accelerators, available, detected, loading, error, load, canDiagnose, diagnose],
  );
}

/**
 * Pick the best concrete backend that satisfies a `ComputeBackend`
 * preference, given a detection result.
 *
 *  • `"auto"`           → the highest-priority *available* accelerator
 *                         (`npu` ▶ `gpu` ▶ `cpu`).
 *  • `"npu" | "gpu"`    → the matching available entry, else fall back to
 *                         the auto choice (so a user pinned to NPU on a
 *                         host without one still gets *something* useful).
 *  • `"cpu"`            → the first CPU entry in the list.
 *
 * Returns `null` if `accelerators` is empty (which shouldn't happen — the
 * Rust side always appends a CPU fallback — but keeps the type honest).
 */
export function resolveBackend(
  preference: ComputeBackend,
  accelerators: AcceleratorInfo[],
): AcceleratorInfo | null {
  if (accelerators.length === 0) return null;
  const available = accelerators.filter((a) => a.available);
  if (preference === "cpu") {
    return (
      accelerators.find((a) => a.id === "cpu") ??
      available[0] ??
      accelerators[0] ??
      null
    );
  }
  if (preference === "npu" || preference === "gpu") {
    const exact = available.find((a) => a.id === preference);
    if (exact) return exact;
  }
  // "auto" or fall-through after a user-pinned bucket isn't available.
  return (
    available.find((a) => a.id === "npu") ??
    available.find((a) => a.id === "gpu") ??
    available.find((a) => a.id === "cpu") ??
    accelerators[0] ??
    null
  );
}
