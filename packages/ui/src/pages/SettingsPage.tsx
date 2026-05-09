/**
 * SettingsPage — categorised configuration surface.
 *
 * Sections: Audio · Model · AI · Appearance · Shortcuts · About.
 */
import { useState } from "react";
import {
  Cpu,
  Mic,
  Sparkles,
  Palette,
  Keyboard,
  Info,
  KeyRound,
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import {
  AI_PROVIDERS,
  WHISPER_MODELS,
  useAiStore,
  useOnboardingStore,
  type AiProvider,
  type ComputeBackend,
  type SummaryLength,
  type WhisperModelId,
} from "@voxnap/core";

import { Card } from "../components/ui/Card.js";
import { Toggle } from "../components/ui/Toggle.js";
import { Slider } from "../components/ui/Slider.js";
import { Select } from "../components/ui/Select.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Kbd } from "../components/ui/Kbd.js";
import { ModelManagerPanel } from "../components/ModelManagerPanel.js";
import { ComputeBackendPicker } from "../components/ComputeBackendPicker.js";
import { useTheme, type ThemeMode } from "../hooks/useTheme.js";
import { formatShortcut } from "../hooks/useShortcuts.js";
import { useOnboarding } from "../hooks/useOnboarding.js";

const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "tr", label: "Türkçe" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
];

const SECTIONS = [
  { id: "audio", label: "Audio", icon: Mic },
  { id: "model", label: "Model", icon: Cpu },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
] as const;

export interface SettingsPageProps {
  modelId: WhisperModelId;
  onModelChange: (id: WhisperModelId) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  /** Whisper translate-to-English toggle. */
  translate?: boolean;
  onTranslateChange?: (v: boolean) => void;
}

export function SettingsPage({
  modelId,
  onModelChange,
  language,
  onLanguageChange,
  translate = false,
  onTranslateChange,
}: SettingsPageProps) {
  const [active, setActive] = useState<(typeof SECTIONS)[number]["id"]>("audio");

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl gap-6 p-4 sm:p-6">
      <aside className="hidden w-44 shrink-0 md:block">
        <div className="sticky top-4 flex flex-col gap-0.5">
          <h1 className="mb-3 text-2xl font-semibold tracking-tight text-text">
            Settings
          </h1>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActive(s.id)}
                className={clsx(
                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  active === s.id
                    ? "bg-brand-gradient-soft text-text"
                    : "text-text-subtle hover:bg-surface-3 hover:text-text",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {s.label}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="min-w-0 flex-1 space-y-5">
        <h1 className="text-2xl font-semibold tracking-tight text-text md:hidden">
          Settings
        </h1>

        {/* Mobile section picker */}
        <div className="flex flex-wrap gap-1.5 md:hidden">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs font-medium",
                active === s.id
                  ? "border-brand-500 bg-brand-gradient-soft text-text"
                  : "border-border bg-surface-2 text-text-subtle",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {active === "audio" && <AudioSection />}
        {active === "model" && (
          <ModelSection
            modelId={modelId}
            onModelChange={onModelChange}
            language={language}
            onLanguageChange={onLanguageChange}
            translate={translate}
            onTranslateChange={onTranslateChange}
          />
        )}
        {active === "ai" && <AiSection />}
        {active === "appearance" && <AppearanceSection />}
        {active === "shortcuts" && <ShortcutsSection />}
        {active === "about" && <AboutSection />}
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {description && (
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      )}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="text-sm font-medium text-text">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-muted">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function AudioSection() {
  const vadThreshold = useOnboardingStore((s) => s.vadThreshold);
  const setVadThreshold = useOnboardingStore((s) => s.setVadThreshold);
  const vadEnabled = useOnboardingStore((s) => s.vadEnabled);
  const setVadEnabled = useOnboardingStore((s) => s.setVadEnabled);
  const [gain, setGain] = useState(0);

  return (
    <Section
      title="Audio"
      description="How Voxnap captures and pre-processes microphone input."
    >
      <Toggle
        checked={vadEnabled}
        onChange={setVadEnabled}
        label="Voice activity detection (VAD)"
        description="Skip inference on silent windows to save CPU and prevent hallucinations."
      />

      <Field
        label="VAD sensitivity"
        description={`RMS energy threshold. Lower = more sensitive. Current: ${vadThreshold.toFixed(3)}`}
      >
        <Slider
          min={0}
          max={0.1}
          step={0.001}
          value={vadThreshold}
          onChange={(e) => setVadThreshold(Number(e.currentTarget.value))}
          formatValue={(n) => n.toFixed(3)}
        />
      </Field>

      <Field
        label="Input gain"
        description="Boost or attenuate the captured signal in dB."
      >
        <Slider
          min={-12}
          max={12}
          step={1}
          value={gain}
          onChange={(e) => setGain(Number(e.currentTarget.value))}
          unit=" dB"
        />
      </Field>
    </Section>
  );
}

function ModelSection({
  modelId,
  onModelChange,
  language,
  onLanguageChange,
  translate,
  onTranslateChange,
}: {
  modelId: WhisperModelId;
  onModelChange: (id: WhisperModelId) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  translate: boolean;
  onTranslateChange?: (v: boolean) => void;
}) {
  const [threads, setThreads] = useState(4);
  const computeBackend = useOnboardingStore((s) => s.computeBackend);
  const setComputeBackend = useOnboardingStore((s) => s.setComputeBackend);
  return (
    <Section
      title="Model"
      description="Whisper.cpp model used for transcription. Download new models or remove ones you don't need."
    >
      <Field
        label="Whisper model"
        description="Pick the active model and manage what's installed on this device."
      >
        <ModelManagerPanel
          selectedModelId={modelId}
          onSelect={onModelChange}
        />
      </Field>

      <Field
        label="Compute backend"
        description="Where models run. Auto picks the fastest accelerator detected on this device — usually an NPU or GPU when one is available."
      >
        <ComputeBackendPicker
          value={computeBackend}
          onChange={(b: ComputeBackend) => setComputeBackend(b)}
          hideHeader
        />
      </Field>

      <Field
        label="Quick switch"
        description="Same selection, plain dropdown. Handy when you've already downloaded several models."
      >
        <Select value={modelId} onChange={(e) => onModelChange(e.target.value as WhisperModelId)}>
          {Object.values(WHISPER_MODELS).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} (~{m.approxSizeMb} MB)
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Language">
        <Select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Threads">
        <Slider
          min={1}
          max={16}
          step={1}
          value={threads}
          onChange={(e) => setThreads(Number(e.currentTarget.value))}
          formatValue={(n) => `${n} thread${n === 1 ? "" : "s"}`}
        />
      </Field>

      <Toggle
        checked={translate}
        onChange={(v) => onTranslateChange?.(v)}
        label="Translate to English"
        description="Whisper translates the spoken language to English on the fly."
      />
    </Section>
  );
}

function AiSection() {
  const provider = useAiStore((s) => s.provider);
  const setProvider = useAiStore((s) => s.setProvider);
  const apiKey = useAiStore((s) => s.apiKey);
  const setApiKey = useAiStore((s) => s.setApiKey);
  const summaryLength = useAiStore((s) => s.summaryLength);
  const setSummaryLength = useAiStore((s) => s.setSummaryLength);
  const autoSummarise = useAiStore((s) => s.autoSummarise);
  const setAutoSummarise = useAiStore((s) => s.setAutoSummarise);
  const liveAi = useAiStore((s) => s.liveAi);
  const setLiveAi = useAiStore((s) => s.setLiveAi);

  const info = AI_PROVIDERS[provider];

  return (
    <Section
      title="AI"
      description="Pick a provider for live summaries, action items and chat."
    >
      <Field label="Provider">
        <Select value={provider} onChange={(e) => setProvider(e.target.value as AiProvider)}>
          {Object.values(AI_PROVIDERS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.local ? " · on-device" : " · cloud"}
            </option>
          ))}
        </Select>
        <Badge tone={info.local ? "success" : "warning"} className="mt-2 w-fit">
          {info.local ? "Audio + transcript stay on this device." : "Transcripts will leave this device."}
        </Badge>
      </Field>

      {info.needsApiKey && (
        <Field
          label="API key"
          description="Stored locally only. Voxnap never proxies your key."
        >
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
            <input
              type="password"
              value={apiKey}
              placeholder="sk-…"
              onChange={(e) => setApiKey(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-8 pr-3 text-sm text-text outline-none focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
        </Field>
      )}

      <Field
        label="Summary length"
        description="How verbose the AI should be."
      >
        <Select
          value={summaryLength}
          onChange={(e) => setSummaryLength(e.target.value as SummaryLength)}
        >
          <option value="short">Short — 3 bullets</option>
          <option value="medium">Medium — 5 bullets</option>
          <option value="long">Long — 7 bullets</option>
        </Select>
      </Field>

      <Toggle
        checked={liveAi}
        onChange={setLiveAi}
        label="Otomatik canlı özet"
        description="Sen konuşurken her birkaç saniyede bir TL;DR'ı yeniden üretir. Kapalıyken de panel görünür kalır ve istediğin zaman 'Regenerate' butonuyla manuel özet alabilirsin — varsayılanı kapalıdır çünkü çok kısa konuşma parçalarından üretilen taslaklar genelde anlamsız çıkıyor."
      />
      <Toggle
        checked={autoSummarise}
        onChange={setAutoSummarise}
        label="Durdurunca özet oluştur"
        description="Kaydı durdurduğun anda son halinden tek seferlik nihai bir özet üretir."
      />

    </Section>
  );
}

function AppearanceSection() {
  const { mode, setMode } = useTheme();

  return (
    <Section
      title="Appearance"
      description="Light, dark, or follow your system. Voxnap remembers."
    >
      <div className="grid grid-cols-3 gap-2">
        {(["system", "light", "dark"] as ThemeMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={clsx(
              "flex flex-col items-center gap-2 rounded-xl border p-4 text-xs font-medium transition-colors",
              mode === m
                ? "border-brand-500 bg-brand-gradient-soft text-text"
                : "border-border bg-surface-2 text-text-subtle hover:border-brand-500/40 hover:text-text",
            )}
          >
            <ThemeSwatch mode={m} />
            <span className="capitalize">{m}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function ThemeSwatch({ mode }: { mode: ThemeMode }) {
  // Tiny preview rectangle showing the theme.
  if (mode === "system") {
    return (
      <div className="flex h-12 w-full overflow-hidden rounded-md border border-border">
        <div className="flex-1 bg-zinc-50" />
        <div className="flex-1 bg-zinc-900" />
      </div>
    );
  }
  return (
    <div
      className={clsx(
        "h-12 w-full rounded-md border border-border",
        mode === "dark" ? "bg-zinc-900" : "bg-zinc-50",
      )}
    />
  );
}

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "mod+k", description: "Open command palette" },
  { keys: "mod+.", description: "Start / stop recording" },
  { keys: "mod+,", description: "Open settings" },
  { keys: "mod+shift+c", description: "Copy transcript" },
  { keys: "mod+s", description: "Save session" },
];

function ShortcutsSection() {
  return (
    <Section
      title="Shortcuts"
      description="Voxnap is keyboard-first. Most things are one chord away."
    >
      <ul className="divide-y divide-border">
        {SHORTCUTS.map((s) => (
          <li key={s.keys} className="flex items-center justify-between py-2.5">
            <span className="text-sm text-text">{s.description}</span>
            <span className="flex items-center gap-1">
              {formatShortcut(s.keys)
                .split(" ")
                .map((p, i) => (
                  <Kbd key={i}>{p}</Kbd>
                ))}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AboutSection() {
  const onboarding = useOnboarding();

  const handleRerunSetup = () => {
    // `reset()` flips `completed` back to false and rewinds to step 0.
    // The next render of <App /> will swap to <OnboardingPage />.
    onboarding.reset();
  };

  return (
    <Section title="About" description="Voxnap is privacy-first by design.">
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <Item label="Version" value="0.2.0-dev" />
        <Item label="License" value="MIT" />
        <Item label="Engine" value="whisper.cpp · whisper-rs · whisper.wasm" />
        <Item label="Models folder" value="./models" mono />
      </dl>
      <p className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-text-subtle">
        Voxnap runs the same React UI on Windows, macOS, Linux, iOS, Android
        and the browser. Audio capture and inference both stay on-device by
        default — your recordings never leave your machine unless you
        explicitly pick a cloud AI provider above.
      </p>

      <div className="mt-1 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 p-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">First-run setup</div>
          <div className="mt-0.5 text-xs text-muted">
            Replay the welcome wizard to reconfigure your microphone, model
            and AI provider from scratch.
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={handleRerunSetup}
        >
          Run setup again
        </Button>
      </div>
    </Section>
  );
}

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
      <span className="text-xs text-muted">{label}</span>
      <span
        className={clsx("text-xs text-text", mono && "font-mono text-[11px]")}
      >
        {value}
      </span>
    </div>
  );
}
