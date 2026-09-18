import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#F8F8F5",
        ink: "#202321",
        muted: "#6B7069",
        line: "#E3E3DC",
        forest: {
          DEFAULT: "#176B52",
          dark: "#11513E",
          light: "#E8F1ED",
        },
        credit: {
          DEFAULT: "#9A7B2E",
          light: "#F5EFDD",
        },
        danger: "#8A3B2E",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "IBM Plex Sans", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        DEFAULT: "3px",
        sm: "2px",
        md: "4px",
        lg: "6px",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 180ms ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;