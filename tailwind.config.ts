import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#161513",
        parchment: "#faf7f2",
        pine: "#2f4f3e",
        cranberry: "#8c2f39",
      },
    },
  },
  plugins: [],
} satisfies Config;
