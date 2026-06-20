import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          950: "#0a0f1a",
          900: "#111827",
          800: "#1f2937",
          700: "#374151",
        },
        accent: {
          DEFAULT: "#6366f1",
          hover: "#818cf8",
        },
      },
      boxShadow: {
        glow: "0 0 40px rgba(99, 102, 241, 0.15)",
      },
    },
  },
  plugins: [],
};

export default config;
