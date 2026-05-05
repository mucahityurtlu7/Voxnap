/**
 * ModelStep — choose which Whisper model to use.
 *
 * Renders every entry from `WHISPER_MODELS` as a card, complete with size
 * estimate, English-only / multilingual badge and a "recommended" hint on
 * the default model. Selection is purely metadata — the actual model
 * download happens in the engine layer when transcription first starts.
 */
import clsx from "clsx";
import { CheckCircle2, Cpu, Gauge, Sparkles } from "lucide-react";
import {
  DEFAULT_MODEL,
  WHISPER_MODELS,
  type WhisperModelId,
} from "@voxnap/core";

import { Badge } from "../../components/ui/Badge.js";

export interface ModelStepProps {
  value: WhisperModelId;
  onChange: (id: WhisperModelId) => void;
}

/**
 * A rough quality / speed hint per model.
 *
 * We don't ship measured numbers — these are coarse buckets so the user
 * gets a feel for the trade-off before downloading 500 MB.
 */
const HINTS: Record<
  WhisperModelId,
  { speed: "fastest" | "fast" | "balanced" | "slow"; quality: 1 | 2 | 3 | 4 }
> = {
  "tiny.q5_1": { speed: "fastest", quality: 1 },
  "tiny.en.q5_1": { speed: "fastest", quality: 2 },
  "base.q5_1": { speed: "fast", quality: 2 },
  "base.en.q5_1": { speed: "fast", quality: 3 },
  "small.q5_1": { speed: "balanced", quality: 3 },
  "small.en.q5_1": { speed: "balanced", quality: 4 },
  "medium.q5_1": { speed: "slow", quality: 4 },
};

const SPEED_LABEL = {
  fastest: "Fastest",
  fast: "Fast",
  balanced: "Balanced",
  slow: "Slowest",
};

export function ModelStep({ value, onChange }: ModelStepProps) {
  const models = Object.values(WHISPER_MODELS);

  return (
    <div role="radiogroup" aria-label="Whisper model" className="flex flex-col gap-2">
      {models.map((m) => {
        const selected = value === m.id;
        const hint = HINTS[m.id];
        const isRecommended = m.id === DEFAULT_MODEL;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(m.id)}
            className={clsx(
              "flex items-start gap-3 rounded-xl border p-3 text-left outline-none transition-all duration-200",
              "focus-visible:ring-2 focus-visible:ring-brand-500/40",
              selected
                ? "border-brand-500 bg-brand-gradient-soft shadow-glow"
                : "border-border bg-surface-2 hover:border-brand-500/40",
            )}
          >
            <div
              className={clsx(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                selected
                  ? "bg-brand-500 text-white"
                  : "bg-surface-3 text-muted",
              )}
            >
              {selected ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Cpu className="h-4 w-4" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text">{m.label}</span>
                <span className="text-[11px] font-mono text-muted">
                  ~{m.approxSizeMb} MB
                </span>
                {isRecommended && (
                  <Badge
                    tone="brand"
                    icon={<Sparkles className="h-3 w-3" />}
                    size="sm"
                  >
                    Recommended
                  </Badge>
                )}
                <Badge tone={m.englishOnly ? "amber" : "sky"} size="sm">
                  {m.englishOnly ? "English-only" : "Multilingual"}
                </Badge>
              </div>

              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                  <Gauge className="h-3 w-3" />
                  {SPEED_LABEL[hint.speed]}
                </span>
                <QualityMeter value={hint.quality} />
              </div>
            </div>
          </button>
        );
      })}

      <p className="mt-1 rounded-xl border border-border bg-surface-2 px-3 py-2 text-[11px] text-text-subtle">
        Models are downloaded on first use into <code>./models</code> and
        loaded directly by whisper.cpp. You can change this any time from
        Settings → Model.
      </p>
    </div>
  );
}

function QualityMeter({ value }: { value: 1 | 2 | 3 | 4 }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>Quality</span>
      <span className="flex items-center gap-0.5">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={clsx(
              "h-2 w-1 rounded-sm",
              i <= value ? "bg-brand-500" : "bg-border-strong",
            )}
          />
        ))}
      </span>
    </span>
  );
}
