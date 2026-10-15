import type { Config } from "tailwindcss";

/**
 * Design B "Ladan". The default `slate` scale is replaced by a warm, field-green-tinted ink scale so the
 * existing pages pick up the new look; `brand` is barn red (text-safe on paper, 4.8:1).
 * Palette: paper #F2EAD6, ink #14211A, hay #E9B73A, barn #B83A24, night #0F2118, sage #8FB59C.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#f2ead6",
        card: "#fbf6e8",
        ink: "#14211a",
        hay: "#e9b73a",
        barn: "#b83a24",
        night: { DEFAULT: "#0f2118", 2: "#17342a" },
        sage: "#8fb59c",
        brand: { 50: "#fbf6e8", 100: "#f2ead6", 500: "#b83a24", 600: "#b83a24", 700: "#9c2f1c", 900: "#14211a" },
        slate: {
          50: "#f7f1e0",
          100: "#efe6cd",
          200: "#e0d6b8",
          300: "#cfc4a2",
          400: "#8a9588",
          500: "#5f6d63",
          600: "#4d5b50",
          700: "#34443a",
          800: "#22322a",
          900: "#14211a",
        },
      },
      fontFamily: {
        sans: ["'Bricolage Grotesque Variable'", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
      boxShadow: {
        sticker: "4px 4px 0 #14211a",
        "sticker-lg": "5px 5px 0 #14211a",
        "sticker-hay": "4px 4px 0 #e9b73a",
      },
    },
  },
  plugins: [],
} satisfies Config;
