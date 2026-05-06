/**
 * AiStep — pick the assistant for summaries, action items and chat.
 *
 * Cloud providers reveal an API key field; on-device options (mock,
 * llama.cpp, Ollama) make it clear nothing leaves the machine. The whole
 * step is skippable — defaults are sensible and the user can wire this up
 * later from Settings → AI.
 */
import clsx from "clsx";
import { CheckCircle2, KeyRound, Lock, Cloud } from "lucide-react";
import {
  AI_PROVIDERS,
  type AiProvider,
  type SummaryLength,
} from "@voxnap/core";

import { Badge } from "../../components/ui/Badge.js";
import { Select } from "../../components/ui/Select.js";

export interface AiStepProps {
  provider: AiProvider;
  onProviderChange: (p: AiProvider) => void;
  apiKey: string;
  onApiKeyChange: (k: string) => void;
  summaryLength: SummaryLength;
  onSummaryLengthChange: (l: SummaryLength) => void;
}

const DESCRIPTIONS: Record<AiProvider, string> = {
  mock: "Built-in placeholder. Great for trying Voxnap without committing.",
  local: "Runs llama.cpp directly on this device — fully offline.",
  ollama: "Talks to a local Ollama server on your network. No internet needed.",
  openai: "Uses your OpenAI API key. Transcripts leave the device.",
  anthropic: "Uses your Anthropic API key. Transcripts leave the device.",
};

export function AiStep({
  provider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  summaryLength,
  onSummaryLengthChange,
}: AiStepProps) {
  const info = AI_PROVIDERS[provider];

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="AI provider" className="grid gap-1.5">
        {Object.values(AI_PROVIDERS).map((p) => {
          const selected = provider === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onProviderChange(p.id)}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left outline-none transition-all duration-150",
                "focus-visible:ring-2 focus-visible:ring-brand-500/40",
                selected
                  ? "border-brand-500 bg-brand-gradient-soft shadow-glow"
                  : "border-border bg-surface-2 hover:border-brand-500/40",
              )}
            >
              <div
                className={clsx(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                  selected
                    ? "bg-brand-500 text-white"
                    : "bg-surface-3 text-muted",
                )}
              >
                {selected ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : p.local ? (
                  <Lock className="h-3.5 w-3.5" />
                ) : (
                  <Cloud className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-text">
                    {p.label}
                  </span>
                  <Badge tone={p.local ? "success" : "warning"} size="sm">
                    {p.local ? "On-device" : "Cloud"}
                  </Badge>
                  {p.needsApiKey && (
                    <Badge tone="brand" size="sm">
                      API key
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted">
                  {DESCRIPTIONS[p.id]}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {info.needsApiKey && (
        <div>
          <label
            htmlFor="vx-onboarding-api-key"
            className="text-sm font-medium text-text"
          >
            API key
          </label>
          <p className="mt-0.5 text-xs text-muted">
            Stored locally only. Voxnap never proxies it through a server.
          </p>
          <div className="relative mt-1.5">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              id="vx-onboarding-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder="sk-…"
              onChange={(e) => onApiKeyChange(e.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-sm text-text outline-none focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
        </div>
      )}

      <div>
        <label className="text-sm font-medium text-text">Summary length</label>
        <p className="mt-0.5 text-xs text-muted">
          How verbose the AI should be when wrapping up a session.
        </p>
        <Select
          className="mt-1.5"
          value={summaryLength}
          onChange={(e) =>
            onSummaryLengthChange(e.currentTarget.value as SummaryLength)
          }
        >
          <option value="short">Short — 3 bullets</option>
          <option value="medium">Medium — 5 bullets</option>
          <option value="long">Long — 7 bullets</option>
        </Select>
      </div>
    </div>
  );
}

/** Validation helper used by OnboardingPage to disable Next when needed. */
export function isAiStepValid(provider: AiProvider, apiKey: string): boolean {
  const info = AI_PROVIDERS[provider];
  return !info.needsApiKey || apiKey.trim().length > 0;
}
