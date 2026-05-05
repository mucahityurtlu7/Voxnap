import { useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronDown, Headphones, Mic, Speaker as SpeakerIcon } from "lucide-react";
import type { AudioDevice } from "@voxnap/core";

import { useEngine } from "../engine/EngineProvider.js";

export interface DeviceSelectProps {
  value?: string;
  onChange: (deviceId: string | undefined) => void;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
}

const KIND_ICON = {
  microphone: Mic,
  headset: Headphones,
  system: SpeakerIcon,
  virtual: SpeakerIcon,
};

export function DeviceSelect({
  value,
  onChange,
  className,
  disabled,
  compact,
}: DeviceSelectProps) {
  const engine = useEngine();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    engine
      .listDevices()
      .then((d) => {
        if (!cancelled) setDevices(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  if (error) {
    return <p className={clsx("text-xs text-rose-500", className)}>{error}</p>;
  }

  const selected = devices.find((d) => d.id === value) ?? devices.find((d) => d.isDefault);
  const Icon = KIND_ICON[selected?.kind ?? "microphone"];

  return (
    <label
      className={clsx(
        "relative inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 transition-colors",
        "focus-within:border-brand-500/60 focus-within:ring-2 focus-within:ring-brand-500/20",
        compact ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm",
        disabled && "opacity-60",
        className,
      )}
    >
      <Icon className={clsx("h-3.5 w-3.5 shrink-0 text-muted")} />
      <select
        className="h-full w-full appearance-none bg-transparent pr-5 text-text outline-none"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Default device</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
            {d.isDefault ? " · default" : ""}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-muted" />
    </label>
  );
}
