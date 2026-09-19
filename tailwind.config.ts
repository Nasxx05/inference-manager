import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm ivory surface with dark editorial type. The palette is warm, not
        // gray: every neutral carries a slight yellow-red cast so large flat
        // areas read as paper rather than as a default UI background.
        canvas: "#F7F5F0",
        // Slightly lighter than canvas, for surfaces that sit on top of it.
        paper: "#FCFBF8",
        ink: "#1B1D1A",
        muted: "#6E7269",
        line: "#E5E1D8",
        // Stronger hairline for hover and active states.
        lineStrong: "#D3CEC1",
        forest: {
          DEFAULT: "#1B5E46",
          dark: "#123F2F",
          light: "#E9F0EB",
        },
        credit: {
          DEFAULT: "#8F7130",
          light: "#F4EEDA",
        },
        // Secondary warm accent, used sparingly for optional/recommended states.
        ember: {
          DEFAULT: "#C4703C",
          light: "#F6E8DC",
        },
        danger: {
          DEFAULT: "#8A3B2E",
          // Warm tint for the "does not fit" surface — muted, never alarming.
          light: "#F7EDEA",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "IBM Plex Sans", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "monospace"],
        // Editorial display face, for large headings only — never body copy.
        display: ["var(--font-display)", "Newsreader", "Georgia", "serif"],
      },
      borderRadius: {
        DEFAULT: "3px",
        sm: "2px",
        md: "4px",
        lg: "6px",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "mark-settle": {
          "0%, 100%": { transform: "translateY(0)", opacity: "0.5" },
          "50%": { transform: "translateY(-7px)", opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 220ms ease-out both",
        "mark-settle": "mark-settle 1000ms ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;