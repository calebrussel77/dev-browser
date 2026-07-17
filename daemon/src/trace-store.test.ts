import { describe, expect, it } from "vitest";
import { access, rm, utimes, writeFile } from "node:fs/promises";

import { TraceStore, TRACE_MAX_BYTES, TRACE_RETENTION, traceCapabilityWarnings, traceSecretsForAction } from "./trace-store.js";

describe("bounded redacted trace store", () => {
  it("integrates success, failure, echoed-input redaction, and external capability warnings", async () => {
    const directory = `traces-integration-${process.pid}-${Date.now()}`;
    const store = new TraceStore(directory);
    const secret = "typed-integration-secret";
    try {
      const secrets = traceSecretsForAction({ kind: "type", text: secret });
      const success = await store.save({
        actionId: "success", action: "type", page: { before: { stateId: "doc-1:1" }, after: { stateId: "doc-1:2" } },
        diagnostics: { consoleErrors: [`echo ${secret}`] }, attempts: [{ attempt: 1, inputMethod: "keyboard" }],
        warnings: traceCapabilityWarnings("connected"),
      }, undefined, secrets);
      const successRecord = await store.read(success.id);
      expect(JSON.stringify(successRecord)).not.toContain(secret);
      expect(successRecord).toMatchObject({ action: "type", warnings: [expect.stringMatching(/External CDP/)] });

      const failure = await store.save({
        actionId: "failure", action: "paste", error: { code: "STALE_STATE", message: `failed ${secret}` },
        recoveryHints: ["dev-browser observe"], diagnostics: { pageErrors: [secret] },
      }, undefined, secrets);
      const failureRecord = await store.read(failure.id);
      expect(JSON.stringify(failureRecord)).not.toContain(secret);
      expect(failureRecord).toMatchObject({ error: { code: "STALE_STATE" }, recoveryHints: ["dev-browser observe"] });
      expect(traceCapabilityWarnings("launched")).toEqual([]);
    } finally {
      await rm(store.absoluteDirectory, { recursive: true, force: true });
    }
  });

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

      const echoedSecret = "typed-secret-echo";
      const echoed = await store.save({ diagnostics: { consoleErrors: [`entered ${echoedSecret}`] } }, undefined, [echoedSecret]);
      expect(JSON.stringify(await store.read(echoed.id))).not.toContain(echoedSecret);

      const orphanId = store.allocateId();
      const orphan = await store.artifactPath(orphanId, "before.png");
      await writeFile(orphan, "orphan");
      const old = new Date(Date.now() - 10 * 60_000);
      await utimes(orphan, old, old);
      await store.save({ actionId: "cleanup", action: "observe" });
      await expect(access(orphan)).resolves.toBeUndefined();
      await store.removeArtifacts(orphanId);
      await writeFile(orphan, "released-orphan");
      await utimes(orphan, old, old);
      await store.save({ actionId: "cleanup-released", action: "observe" });
      await expect(access(orphan)).rejects.toThrow();
    } finally {
      await rm(store.absoluteDirectory, { recursive: true, force: true });
    }
  });
});
