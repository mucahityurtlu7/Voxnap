/**
 * ModelStep — choose **and download** a Whisper model.
 *
 * The previous version of this step just selected a model id; the file was
 * expected to be downloaded out-of-band by the user (`pnpm fetch:model`).
 * That worked for developers but not for end users — and the engine's
 * `model-not-found` error was the first thing they hit on the live page.
 *
 * The current version uses `ModelManagerPanel`, which:
 *   • lists every supported ggml model;
 *   • shows install state (Installed / Not installed / Downloading / Error);
 *   • exposes Download · Cancel · Delete inline, talking to the active
 *     `IModelManager` (Tauri on desktop, Mock on web).
 *
 * Selecting a row sets the configured model id; an additional callout at
 * the bottom nudges the user to download the selected model before
 * leaving the wizard, so they hit "All set" with a working pipeline.
 */
import clsx from "clsx";
import { CloudDownload, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  WHISPER_MODELS,
  type WhisperModelId,
} from "@voxnap/core";

import { ModelManagerPanel } from "../../components/ModelManagerPanel.js";
import { Button } from "../../components/ui/Button.js";
import { useModels } from "../../hooks/useModels.js";

export interface ModelStepProps {
  value: WhisperModelId;
  onChange: (id: WhisperModelId) => void;
}

export function ModelStep({ value, onChange }: ModelStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <ModelManagerPanel selectedModelId={value} onSelect={onChange} />
      <SelectedModelCallout modelId={value} />
      <p className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-subtle">
        Models are saved in your app data folder. You can manage them any
        time from{" "}
        <span className="font-medium text-text">Settings → Model</span>.
      </p>
    </div>
  );
}

/**
 * Inline call-to-action that mirrors the row-level button but pulls the
 * user's eye when their selected model is not yet installed. We don't
 * block "Continue" on this — some users will want to defer the download
 * until after onboarding — but we want the missing-model state to feel
 * very obvious.
 */
function SelectedModelCallout({ modelId }: { modelId: WhisperModelId }) {
  const { getStatus, getProgress, download, cancel } = useModels();
  const status = getStatus(modelId);
  const progress = getProgress(modelId);
  const meta = WHISPER_MODELS[modelId];

  const isDownloading =
    progress?.state === "downloading" || progress?.state === "starting";
  const isError = progress?.state === "error";

  if (status?.downloaded) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">{meta.label} is installed.</div>
          <div className="opacity-80">
            You're ready to record once you finish the setup.
          </div>
        </div>
      </div>
    );
  }

  if (isDownloading && progress) {
    const pct = Math.max(0, Math.min(1, progress.percent));
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-brand-500/40 bg-brand-gradient-soft p-3">
        <div className="flex items-center gap-2 text-xs text-text">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />
          <div className="flex-1 font-medium">
            Downloading {meta.label}…
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void cancel(modelId)}
          >
            Cancel
          </Button>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width] duration-200"
            style={{ width: `${(pct * 100).toFixed(2)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>{(pct * 100).toFixed(1)}%</span>
          <span>
            {progress.totalBytes
              ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(
                  progress.totalBytes,
                )}`
              : ""}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "flex items-center gap-3 rounded-xl border p-3",
        isError
          ? "border-rose-500/40 bg-rose-500/10"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <AlertTriangle
        className={clsx(
          "h-4 w-4 shrink-0",
          isError ? "text-rose-500" : "text-amber-500",
        )}
      />
      <div className="min-w-0 flex-1 text-xs">
        <div className="font-medium text-text">
          {isError
            ? `${meta.label} failed to download.`
            : `${meta.label} hasn't been downloaded yet.`}
        </div>
        <div className="text-text-subtle">
          {isError && progress?.message
            ? progress.message
            : `Downloading is about ~${meta.approxSizeMb} MB. You can keep going and download later, but the live page will show an error until it's installed.`}
        </div>
      </div>
      <Button
        size="sm"
        variant="primary"
        leftIcon={<CloudDownload className="h-3.5 w-3.5" />}
        onClick={() => void download(modelId)}
      >
        {isError ? "Retry" : "Download now"}
      </Button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
