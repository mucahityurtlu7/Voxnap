/**
 * Shared Tailwind preset.
 *
 * Each app extends this in its own `tailwind.config.js` so all platforms
 * pick up the same design tokens automatically:
 *
 *   // apps/web/tailwind.config.js
 *   module.exports = {
 *     presets: [require("@voxnap/ui/tailwind.preset.cjs")],
 *     content: [
 *       "./index.html",
 *       "./src/**\/*.{ts,tsx}",
 *       "../../packages/ui/src/**\/*.{ts,tsx}",
 *     ],
 *   };
 *
 * Theme strategy: `darkMode: "class"` so we can offer a manual toggle
 * (system / light / dark) instead of locking users to OS preferences.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        display: [
          "InterVariable",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        // Semantic surface tokens, driven by CSS variables in styles.css.
        bg: "rgb(var(--vx-bg) / <alpha-value>)",
        surface: "rgb(var(--vx-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--vx-surface-2) / <alpha-value>)",
        "surface-3": "rgb(var(--vx-surface-3) / <alpha-value>)",
        border: "rgb(var(--vx-border) / <alpha-value>)",
        "border-strong": "rgb(var(--vx-border-strong) / <alpha-value>)",
        muted: "rgb(var(--vx-muted) / <alpha-value>)",
        text: "rgb(var(--vx-text) / <alpha-value>)",
        "text-subtle": "rgb(var(--vx-text-subtle) / <alpha-value>)",

        // Brand palette — Voxnap purple/indigo gradient.
        brand: {
          50: "#f4f3ff",
          100: "#ebe9fe",
          200: "#d9d6fe",
          300: "#bdb4fd",
          400: "#9b8afa",
          500: "#7c5cf5",
          600: "#6940ec",
          700: "#5a30d4",
          800: "#4b29ab",
          900: "#3f258a",
          950: "#27155b",
        },
        accent: {
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
        },
        success: { 500: "#10b981" },
        warning: { 500: "#f59e0b" },
        danger: { 500: "#ef4444" },
      },
      borderRadius: {
        sm: "0.375rem",
        DEFAULT: "0.5rem",
        md: "0.625rem",
        lg: "0.875rem",
        xl: "1.125rem",
        "2xl": "1.5rem",
        "3xl": "2rem",
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgb(0 0 0 / 0.04), 0 4px 16px -4px rgb(0 0 0 / 0.08)",
        glow: "0 0 0 1px rgb(124 92 245 / 0.2), 0 8px 32px -8px rgb(124 92 245 / 0.45)",
        ring: "0 0 0 4px rgb(124 92 245 / 0.18)",
      },
      backgroundImage: {
        "brand-gradient":
          "linear-gradient(135deg, #7c5cf5 0%, #c084fc 50%, #f0abfc 100%)",
        "brand-gradient-soft":
          "linear-gradient(135deg, rgb(124 92 245 / 0.16), rgb(192 132 252 / 0.12))",
        "panel-glow":
          "radial-gradient(80% 60% at 50% 0%, rgb(124 92 245 / 0.18), transparent 70%)",
      },
      transitionTimingFunction: {
        "out-back": "cubic-bezier(.22,1.4,.36,1)",
        spring: "cubic-bezier(.34,1.56,.64,1)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(1)", opacity: "0.6" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms cubic-bezier(.22,1.4,.36,1) both",
        "pulse-ring": "pulse-ring 1.6s ease-out infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
