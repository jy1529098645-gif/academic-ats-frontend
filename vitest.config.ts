import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Minimal Vitest setup — enough to run the first few smoke tests. A full
// component-test suite will grow over time; for now we target the pure
// helpers in src/lib/ which have no React or DOM dependencies.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Tests should never hit the dev server or real Supabase; unit tests only.
    testTimeout: 5000,
  },
});
