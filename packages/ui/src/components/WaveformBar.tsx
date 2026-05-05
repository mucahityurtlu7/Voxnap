import { useEffect, useRef } from "react";
import clsx from "clsx";

export interface WaveformBarProps {
  /** Current 0..1 RMS level. Pushed at audio rate (~50 Hz). */
  level: number;
  /** Number of historical bars to keep on screen. */
  history?: number;
  /** When true, animate an idle wave even with zero level. */
  idle?: boolean;
  className?: string;
}

/**
 * Rolling-history waveform with gradient bars + peak highlight.
 *
 * Uses canvas to keep React out of the audio-rate update loop.
 */
export function WaveformBar({
  level,
  history = 96,
  idle = false,
  className,
}: WaveformBarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<Float32Array>(new Float32Array(history));
  const headRef = useRef(0);
  const idleTickRef = useRef(0);

  // Resize buffer when `history` changes.
  useEffect(() => {
    bufferRef.current = new Float32Array(history);
    headRef.current = 0;
  }, [history]);

  // Push the latest level + repaint.
  useEffect(() => {
    const buf = bufferRef.current;

    // Mix in a tiny idle wiggle when nothing is happening, so the bar
    // feels alive even between recordings.
    let value = level;
    if (idle && level < 0.02) {
      idleTickRef.current += 0.18;
      value = 0.12 + Math.sin(idleTickRef.current) * 0.04;
    }

    buf[headRef.current] = value;
    headRef.current = (headRef.current + 1) % buf.length;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const barW = cssW / buf.length;
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, "rgba(124, 92, 245, 0.95)"); // brand-500
    grad.addColorStop(1, "rgba(192, 132, 252, 0.65)"); // fuchsia-300

    let max = 0;
    let maxX = 0;
    for (let i = 0; i < buf.length; i++) {
      const idx = (headRef.current + i) % buf.length;
      const v = buf[idx] ?? 0;
      const h = Math.max(2, v * cssH * 0.95);
      const x = i * barW;
      const y = (cssH - h) / 2;
      ctx.fillStyle = grad;
      ctx.fillRect(x + barW * 0.18, y, Math.max(1.5, barW * 0.64), h);

      if (v > max) {
        max = v;
        maxX = x + barW / 2;
      }
    }

    // Peak highlight dot
    if (max > 0.05) {
      ctx.beginPath();
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.arc(maxX, cssH / 2, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [level, idle]);

  return (
    <canvas
      ref={canvasRef}
      className={clsx(
        "h-12 w-full rounded-xl border border-border bg-surface-2",
        className,
      )}
    />
  );
}
