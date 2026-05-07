/**
 * DoneStep — final "All set" page.
 *
 * Shows a recap of every choice the user made plus a celebratory burst of
 * confetti. The actual "complete + close" CTA lives on this step instead
 * of the shared shell, because we want a bigger, more rewarding button.
 */
import clsx from "clsx";
import {
  CheckCircle2,
  Cpu,
  Languages,
  Mic,
  Palette,
  Sparkles,
  ArrowRight,
  Zap,
} from "lucide-react";
import {
  AI_PROVIDERS,
  WHISPER_MODELS,
  type AiProvider,
  type ComputeBackend,
  type OnboardingTheme,
  type SummaryLength,
  type WhisperModelId,
} from "@voxnap/core";

import { Badge } from "../../components/ui/Badge.js";
import { Button } from "../../components/ui/Button.js";
import { useAccelerators } from "../../hooks/useAccelerators.js";

export interface DoneStepProps {
  theme: OnboardingTheme;
  micVerified: boolean;
  modelId: WhisperModelId;
  language: string;
  translate: boolean;
  /**
   * User's compute-backend preference (`"auto" | "npu" | "gpu" | "cpu"`).
   * Optional so older callers still typecheck; defaults to `"auto"`.
   */
  computeBackend?: ComputeBackend;
  aiProvider: AiProvider;
  summaryLength: SummaryLength;
  onFinish: () => void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  auto: "Auto-detect",
  en: "English",
  tr: "Turkish",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ja: "Japanese",
  zh: "Chinese",
};

const SUMMARY_LABEL: Record<SummaryLength, string> = {
  short: "Short summaries",
  medium: "Medium summaries",
  long: "Long summaries",
};

export function DoneStep({
  theme,
  micVerified,
  modelId,
  language,
  translate,
  computeBackend = "auto",
  aiProvider,
  summaryLength,
  onFinish,
}: DoneStepProps) {
  const model = WHISPER_MODELS[modelId];
  const provider = AI_PROVIDERS[aiProvider];
  const langLabel = LANGUAGE_LABELS[language] ?? language;
  const { accelerators, detected } = useAccelerators();

  // Resolve the user's stored preference into a human-readable runtime
  // target. "Auto" falls through to whichever NPU/GPU/CPU we'd pick today.
  const computeValue = (() => {
    if (computeBackend === "auto") {
      return detected
        ? `Auto · ${detected.label}`
        : "Auto · CPU";
    }
    const match = accelerators.find((a) => a.id === computeBackend);
    if (match) {
      return match.available
        ? match.label
        : `${match.label} (falling back to ${detected?.label ?? "CPU"})`;
    }
    return computeBackend.toUpperCase();
  })();

  const items: { icon: typeof Mic; label: string; value: string }[] = [
    {
      icon: Palette,
      label: "Theme",
      value:
        theme === "system"
          ? "Match system"
          : theme.charAt(0).toUpperCase() + theme.slice(1),
    },
    {
      icon: Mic,
      label: "Microphone",
      value: micVerified ? "Verified" : "Configured later",
    },
    {
      icon: Cpu,
      label: "Model",
      value: `${model.label} · ~${model.approxSizeMb} MB`,
    },
    {
      icon: Zap,
      label: "Compute",
      value: computeValue,
    },
    {
      icon: Languages,
      label: "Language",
      value: translate ? `${langLabel} → English` : langLabel,
    },
    {
      icon: Sparkles,
      label: "AI",
      value: `${provider.label} · ${SUMMARY_LABEL[summaryLength]}`,
    },
  ];

  return (
    <div className="relative flex flex-col gap-3">
      <Confetti />

      <div className="relative flex flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-gradient shadow-glow">
          <CheckCircle2 className="h-6 w-6 text-white" />
        </div>
        <p className="mt-2 max-w-sm text-sm text-text-subtle">
          Voxnap is configured the way you like it. Here's a quick recap —
          you can change any of these any time from{" "}
          <span className="font-medium text-text">Settings</span>.
        </p>
      </div>

      <ul className="divide-y divide-border rounded-xl border border-border bg-surface-2">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <li
              key={it.label}
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
            >
              <span className="flex items-center gap-2 text-text-subtle">
                <Icon className="h-3.5 w-3.5 text-muted" />
                {it.label}
              </span>
              <span className="truncate text-right text-text">{it.value}</span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col items-center gap-2">
        <Button
          variant="primary"
          size="md"
          rightIcon={<ArrowRight className="h-4 w-4" />}
          onClick={onFinish}
          className="w-full sm:w-auto"
        >
          Open Voxnap
        </Button>
        <Badge tone="brand" size="sm">
          You can re-run this setup from Settings → About
        </Badge>
      </div>
    </div>
  );
}

/**
 * Pure-SVG confetti burst.
 *
 * No extra dependency, no canvas — just a handful of staggered, animated
 * shapes positioned around the success icon.
 */
function Confetti() {
  const pieces = Array.from({ length: 18 }, (_, i) => {
    const angle = (i / 18) * Math.PI * 2;
    const distance = 110 + ((i * 13) % 50);
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    const colors = [
      "#7c5cf5",
      "#c084fc",
      "#f0abfc",
      "#22d3ee",
      "#10b981",
      "#f59e0b",
    ];
    const color = colors[i % colors.length];
    const rotate = (i * 37) % 360;
    const delay = (i * 35) % 600;
    const size = 6 + ((i * 3) % 6);
    return { x, y, color, rotate, delay, size, key: i };
  });

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-2 h-0 w-0 -translate-x-1/2"
    >
      {pieces.map((p) => (
        <span
          key={p.key}
          className={clsx("vx-confetti-piece absolute block rounded-[2px]")}
          style={{
            width: `${p.size}px`,
            height: `${p.size * 0.4}px`,
            background: p.color,
            transform: `translate(-50%, -50%) rotate(${p.rotate}deg)`,
            // Custom CSS variables consumed by the keyframe in styles.css
            ["--vx-confetti-x" as string]: `${p.x}px`,
            ["--vx-confetti-y" as string]: `${p.y}px`,
            animationDelay: `${p.delay}ms`,
          }}
        />
      ))}
    </div>
  );
}
