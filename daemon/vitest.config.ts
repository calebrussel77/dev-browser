import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Browser-heavy suites each launch independent Chromium process trees.
    // A single file worker keeps those trees within the Windows job's memory
    // budget; individual tests and browser operations remain asynchronous.
    maxWorkers: 1,
    // Tests drive a real Chromium through trusted input and event-driven
    // waits; the 5s default reads as flaky failures on a loaded machine.
    testTimeout: 30_000,
  },
});
