/**
 * ModelManagerPanel — full management surface for whisper models.
 *
 * Used by:
 *   • SettingsPage (Model section) — full panel with download / delete /
 *     cancel for every known model.
 *   • OnboardingPage (Model step)   — same panel, but with a focused inline
 *     download CTA for the currently selected model on top.
 *
 * The panel never branches on platform: everything goes through `useModels`
 * which under the hood talks to the active `IModelManager` (Tauri or Mock).
 *
 * Design notes
 * ------------
 *  • Status colors are pure Tailwind utilities so the same component looks
 *    correct in light and dark mode without any extra wiring.
 *  • Cancellation produces a `cancelled` event that we surface as a
 *    short-lived toast strip on the affected row, then auto-clears when
 *    the next refresh comes in.
 *  • Delete is hidden behind a confirm() prompt to avoid an accidental
 *    half-gigabyte loss.
 */
import clsx from "clsx";
import {
  Cpu,
  CheckCircle2,
  CloudDownload,
  Loader2,
  Sparkles,
  Trash2,
  X as XIcon,
  AlertTriangle,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  DEFAULT_MODEL,
  type ModelDownloadProgress,
  type ModelStatus,
  type OnnxBundleProgress,
  type WhisperModelId,
} from "@voxnap/core";

import { Badge } from "./ui/Badge.js";
import { Button } from "./ui/Button.js";
import { useModels } from "../hooks/useModels.js";

export interface ModelManagerPanelProps {
  /** Currently selected model id; receives a "selected" highlight. */
  selectedModelId?: WhisperModelId;
  /** Optional callback when the user clicks a model card to select it. */
  onSelect?: (id: WhisperModelId) => void;
  /** When true, hide the "Selected" badge logic. Used in Settings. */
  hideSelectionState?: boolean;
  className?: string;
}

export function ModelManagerPanel({
  selectedModelId,
  onSelect,
  hideSelectionState,
  className,
}: ModelManagerPanelProps) {
  const {
    statuses,
    hydrated,
    lastError,
    supportsOnnxBundle,
    download,
    cancel,
    remove,
    downloadOnnxBundle,
    deleteOnnxBundle,
    getProgress,
    getOnnxProgress,
    refresh,
  } = useModels();

  if (!hydrated && statuses.length === 0) {
    return (
      <div
        className={clsx(
          "flex items-center justify-center rounded-xl border border-border bg-surface-2 p-6 text-sm text-muted",
          className,
        )}
      >
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading models…
      </div>
    );
  }

  return (
    <div className={clsx("flex flex-col gap-3", className)}>
      {lastError && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">{lastError}</div>
          <button
            type="button"
            className="text-rose-600/70 hover:text-rose-600 dark:text-rose-300/70 dark:hover:text-rose-300"
            onClick={() => void refresh()}
            aria-label="Retry"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {statuses.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            progress={getProgress(m.id)}
            onnxProgress={getOnnxProgress(m.id)}
            supportsOnnxBundle={supportsOnnxBundle}
            selected={!hideSelectionState && selectedModelId === m.id}
            onSelect={onSelect}
            onDownload={() => void download(m.id)}
            onCancel={() => void cancel(m.id)}
            onDelete={() => void remove(m.id)}
            onDownloadOnnx={() => void downloadOnnxBundle(m.id)}
            onDeleteOnnx={() => void deleteOnnxBundle(m.id)}
          />
        ))}
      </ul>
    </div>
  );
}

interface ModelRowProps {
  model: ModelStatus;
  progress?: ModelDownloadProgress;
  onnxProgress?: OnnxBundleProgress;
  supportsOnnxBundle: boolean;
  selected: boolean;
  onSelect?: (id: WhisperModelId) => void;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onDownloadOnnx: () => void;
  onDeleteOnnx: () => void;
}

function ModelRow({
  model,
  progress,
  onnxProgress,
  supportsOnnxBundle,
  selected,
  onSelect,
  onDownload,
  onCancel,
  onDelete,
  onDownloadOnnx,
  onDeleteOnnx,
}: ModelRowProps) {
  const isDownloading =
    progress?.state === "downloading" || progress?.state === "starting";
  const isError = progress?.state === "error";
  const isRecommended = model.id === DEFAULT_MODEL;
  const clickable = Boolean(onSelect);

  const handleClickRow = () => {
    if (!onSelect) return;
    if (isDownloading) return;
    onSelect(model.id);
  };

  return (
    <li
      className={clsx(
        "flex flex-col gap-2 rounded-xl border px-3 py-2.5 transition-colors",
        selected
          ? "border-brand-500 bg-brand-gradient-soft shadow-glow"
          : "border-border bg-surface-2",
        clickable && !isDownloading && "cursor-pointer hover:border-brand-500/40",
      )}
      onClick={clickable ? handleClickRow : undefined}
    >
      <div className="flex items-center gap-3">
        <div
          className={clsx(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            model.downloaded
              ? "bg-emerald-500 text-white"
              : selected
                ? "bg-brand-500 text-white"
                : "bg-surface-3 text-muted",
          )}
        >
          {model.downloaded ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Cpu className="h-4 w-4" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text">{model.label}</span>
            <span className="font-mono text-[11px] text-muted">
              ~{model.approxSizeMb} MB
            </span>
            {isRecommended && (
              <Badge
                tone="brand"
                size="sm"
                icon={<Sparkles className="h-3 w-3" />}
              >
                Recommended
              </Badge>
            )}
            <Badge tone={model.englishOnly ? "amber" : "sky"} size="sm">
              {model.englishOnly ? "EN-only" : "Multi"}
            </Badge>
            {model.downloaded ? (
              <Badge tone="success" size="sm">
                Installed
              </Badge>
            ) : isDownloading ? (
              <Badge tone="brand" size="sm">
                Downloading…
              </Badge>
            ) : isError ? (
              <Badge tone="warning" size="sm">
                Error
              </Badge>
            ) : (
              <Badge tone="neutral" size="sm">
                Not installed
              </Badge>
            )}
            {selected && (
              <Badge tone="brand" size="sm">
                Selected
              </Badge>
            )}
          </div>
          {model.path && (
            <div
              className="mt-0.5 truncate font-mono text-[10px] text-text-subtle"
              title={model.path}
            >
              {model.path}
            </div>
          )}
        </div>

        <div
          className="flex shrink-0 items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {isDownloading ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<XIcon className="h-3.5 w-3.5" />}
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : model.downloaded ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => {
                const ok =
                  typeof window === "undefined" ||
                  window.confirm(
                    `Delete ${model.label}? You can re-download it any time.`,
                  );
                if (ok) onDelete();
              }}
            >
              Delete
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<CloudDownload className="h-3.5 w-3.5" />}
              onClick={onDownload}
            >
              Download
            </Button>
          )}
        </div>
      </div>

      {(isDownloading || isError) && progress && (
        <DownloadProgressStrip progress={progress} />
      )}

      {/*
       * Accelerator pack ("hızlandırma paketi") row.
       *
       * Only shown when:
       *   • the active manager supports ONNX bundle commands at all
       *     (web build doesn't), and
       *   • a Xenova ONNX mirror exists for this model id.
       *
       * The ggml model itself doesn't need to be downloaded yet —
       * the user can pre-download the accelerator pack alongside.
       * That said we hide the *download* CTA when the parent ggml
       * is currently downloading because the Rust backend will
       * auto-trigger the bundle download once the ggml is done; a
       * second click would just race against the auto-spawn.
       */}
      {supportsOnnxBundle && model.onnxBundleAvailable !== false && (
        <OnnxBundleRow
          model={model}
          progress={onnxProgress}
          parentDownloading={isDownloading}
          onDownload={onDownloadOnnx}
          onDelete={onDeleteOnnx}
        />
      )}
    </li>
  );
}

interface OnnxBundleRowProps {
  model: ModelStatus;
  progress?: OnnxBundleProgress;
  parentDownloading: boolean;
  onDownload: () => void;
  onDelete: () => void;
}

function OnnxBundleRow({
  model,
  progress,
  parentDownloading,
  onDownload,
  onDelete,
}: OnnxBundleRowProps) {
  const isReady = model.onnxBundleReady === true;
  const isActive =
    progress?.state === "starting" || progress?.state === "downloading";
  const isError = progress?.state === "error";
  const isSkipped = progress?.state === "skipped";

  const sizeLabel = (() => {
    if (model.onnxBundleSizeBytes && model.onnxBundleSizeBytes > 0) {
      return formatBytes(model.onnxBundleSizeBytes);
    }
    return null;
  })();

  return (
    <div
      className={clsx(
        "flex flex-col gap-1.5 rounded-lg border border-dashed p-2",
        isReady
          ? "border-emerald-500/40 bg-emerald-500/5"
          : isActive
            ? "border-brand-500/40 bg-brand-500/5"
            : isError
              ? "border-rose-500/40 bg-rose-500/5"
              : "border-border bg-surface-3/40",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <Zap
          className={clsx(
            "h-3.5 w-3.5 shrink-0",
            isReady
              ? "text-emerald-500"
              : isActive
                ? "text-brand-500"
                : isError
                  ? "text-rose-500"
                  : "text-muted",
          )}
        />
        <div className="min-w-0 flex-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-text">Hızlandırma paketi</span>
            {isReady ? (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                NPU/GPU hazır
              </span>
            ) : isActive ? (
              <span className="rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 dark:text-brand-400">
                İndiriliyor…
              </span>
            ) : isSkipped ? (
              <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                Mevcut değil
              </span>
            ) : isError ? (
              <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
                Hata
              </span>
            ) : (
              <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                Sadece CPU
              </span>
            )}
            {sizeLabel && (
              <span className="font-mono text-[10px] text-muted">{sizeLabel}</span>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-text-subtle">
            {isReady
              ? "ONNX paketi diskinde — sonraki kayıtta NPU/GPU otomatik kullanılır."
              : isActive
                ? progress?.file
                  ? `${progress.file} indiriliyor…`
                  : "Hızlandırma paketi indiriliyor…"
                : isSkipped
                  ? (progress?.message ??
                    "Bu model için ONNX yansısı yok. CPU yolu yine de tam çalışır.")
                  : isError
                    ? (progress?.message ?? "İndirme başarısız oldu.")
                    : parentDownloading
                      ? "ggml modeli indikten sonra otomatik başlayacak."
                      : "NPU/GPU hızlandırması için isteğe bağlı bir paket. ~150-300 MB."}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isReady ? (
            <button
              type="button"
              onClick={() => {
                const ok =
                  typeof window === "undefined" ||
                  window.confirm(
                    `${model.label} için hızlandırma paketini sil? Sonraki kayıt CPU'ya düşecek.`,
                  );
                if (ok) onDelete();
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-text-subtle hover:bg-surface-2 hover:text-text"
            >
              <Trash2 className="h-3 w-3" /> Sil
            </button>
          ) : isActive ? null : isSkipped ? null : (
            <button
              type="button"
              onClick={onDownload}
              disabled={parentDownloading}
              className={clsx(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                parentDownloading
                  ? "cursor-not-allowed border-border bg-surface-2 text-muted"
                  : "border-brand-500/40 bg-brand-500/10 text-brand-600 hover:bg-brand-500/20 dark:text-brand-400",
              )}
              title={
                parentDownloading
                  ? "ggml indirimi bittikten sonra otomatik başlar"
                  : isError
                    ? "Tekrar dene"
                    : "Hızlandırmayı indir"
              }
            >
              <CloudDownload className="h-3 w-3" />
              {isError ? "Tekrar dene" : "İndir"}
            </button>
          )}
        </div>
      </div>

      {isActive && progress && (
        <div className="flex flex-col gap-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width] duration-200"
              style={{
                width: `${(progress.percent * 100).toFixed(2)}%`,
              }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span>
              {progress.totalBytes > 0
                ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                : formatBytes(progress.receivedBytes)}
            </span>
            <span>
              Dosya {progress.fileIndex + 1}/{progress.fileCount}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function DownloadProgressStrip({ progress }: { progress: ModelDownloadProgress }) {
  const pct = Math.max(0, Math.min(1, progress.percent));
  const pctText = `${(pct * 100).toFixed(progress.totalBytes ? 1 : 0)}%`;
  const isError = progress.state === "error";
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={clsx(
          "h-1.5 w-full overflow-hidden rounded-full",
          isError ? "bg-rose-500/15" : "bg-surface-3",
        )}
      >
        <div
          className={clsx(
            "h-full rounded-full transition-[width] duration-200",
            isError
              ? "bg-rose-500"
              : "bg-gradient-to-r from-brand-400 to-brand-600",
          )}
          style={{ width: `${(pct * 100).toFixed(2)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          {isError ? (
            <span className="text-rose-500">
              {progress.message ?? "Download failed"}
            </span>
          ) : progress.state === "starting" ? (
            "Starting…"
          ) : (
            <>
              {formatBytes(progress.receivedBytes)}{" "}
              {progress.totalBytes ? (
                <>
                  / {formatBytes(progress.totalBytes)} · {pctText}
                </>
              ) : null}
            </>
          )}
        </span>
        <span>
          {progress.speedBps ? `${formatBytes(progress.speedBps)}/s` : ""}
        </span>
      </div>
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
