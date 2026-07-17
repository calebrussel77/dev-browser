import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { TraceStore, TRACE_MAX_BYTES, TRACE_RETENTION } from "./trace-store.js";

describe("bounded redacted trace store", () => {
  it("redacts secrets, bounds oversized records, retains the newest traces, and resolves LAST", async () => {
    const directory = `traces-test-${process.pid}-${Date.now()}`;
    const store = new TraceStore(directory);
    try {
      let latest = "";
      for (let index = 0; index < TRACE_RETENTION + 2; index += 1) {
        const saved = await store.save({
          actionId: `action-${index}`,
          action: "click",
          authorization: "Bearer trace-secret",
          message: `trace-secret ${"x".repeat(TRACE_MAX_BYTES)}`,
        });
        latest = saved.id;
      }
      const last = await store.read("LAST");
      expect(last.id).toBe(latest);
      expect(JSON.stringify(last)).not.toContain("trace-secret");
      expect(JSON.stringify(last).length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
      expect(await store.listIds()).toHaveLength(TRACE_RETENTION);
      await expect(store.read("../daemon.pid")).rejects.toThrow(/trace id/i);
    } finally {
      await rm(store.absoluteDirectory, { recursive: true, force: true });
    }
  });
});
