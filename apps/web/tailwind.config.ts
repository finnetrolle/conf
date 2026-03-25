import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        border: "hsl(var(--border))",
        ring: "hsl(var(--ring))",
        card: "hsl(var(--card))",
        muted: "hsl(var(--muted))",
        primary: "hsl(var(--primary))",
        secondary: "hsl(var(--secondary))",
        accent: "hsl(var(--accent))",
        destructive: "hsl(var(--destructive))",
      },
      borderRadius: {
        xl: "1.5rem",
        "2xl": "2rem",
      },
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 20px 60px rgba(15, 23, 42, 0.15)",
      },
    },
  },
  plugins: [],
}

export default config

