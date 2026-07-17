import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Browser-heavy suites each launch independent Chromium process trees.
    // A single file worker keeps those trees within the Windows job's memory
    // budget; individual tests and browser operations remain asynchronous.
    maxWorkers: 1,
  },
});
