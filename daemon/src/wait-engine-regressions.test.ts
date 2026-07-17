import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentProtocolError } from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import {
  startAgentReliabilityFixture,
  type AgentReliabilityFixture,
} from "./test-fixtures/agent-reliability-fixture.js";
import { runWithWait } from "./wait-engine.js";

describe.sequential("wait engine reliability regressions", () => {
  let root = "";
  let manager: BrowserManager;
  let fixture: AgentReliabilityFixture;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-wait-regression-"));
    fixture = await startAgentReliabilityFixture();
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser("wait-regression", { headless: true });
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, root);
    await fixture.close();
  }, 180_000);

  it(
    "matches raw sensitive and long network URLs while returning redacted bounded metadata",
    { timeout: 30_000 },
    async () => {
      const page = await manager.getPage("wait-regression", "raw-network");
      await page.goto(fixture.mainUrl);
      const secret = `sensitive-match-needle-${"x".repeat(400)}`;
      const response = await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 3_000,
          conditions: [
            { kind: "response", match: "contains", value: secret, method: "POST", status: 200 },
          ],
        },
        () =>
          page.evaluate((token) => fetch(`/api/submit?token=${token}`, { method: "POST" }), secret)
      );
      expect(response.waitResult.events.responses[0]?.url).not.toContain(secret);
      expect(response.waitResult.events.responses[0]?.url.length).toBeLessThanOrEqual(160);

      const failed = await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 3_000,
          conditions: [{ kind: "failedRequest", match: "contains", value: secret, method: "GET" }],
        },
        () => page.evaluate((token) => fetch(`/api/failure?token=${token}`).catch(() => {}), secret)
      );
      expect(failed.waitResult.events.failedRequests[0]?.url).not.toContain(secret);
    }
  );

  it("cancels never-resolving popup metadata without delaying cleanup", async () => {
    const page = await manager.getPage("wait-regression", "popup-deadline");
    await page.setContent("<p>ready</p>");
    let aborted = false;
    const started = Date.now();
    const result = await runWithWait(
      page,
      {
        collect: async () => null,
        popupMetadata: async (_popup, signal) =>
          await new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            })
          ),
      },
      { mode: "all", timeoutMs: 1_000, conditions: [{ kind: "popup" }] },
      () =>
        (page as typeof page & { emit(event: string, value: unknown): void }).emit("popup", {
          url: () => "https://example.test/popup",
        })
    );
    expect(result.waitResult.events.popup[0]).toMatchObject({ warning: expect.any(String) });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(750);
  });

  it("bounds huge observations and includes event evidence in timeout details", async () => {
    const page = await manager.getPage("wait-regression", "bounded-timeout");
    await page.setContent(`<input data-dev-browser-ref="R1" value="${"v".repeat(10_000)}">`);
    let timeout: AgentProtocolError | undefined;
    try {
      await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 30,
          conditions: [
            { kind: "ref", ref: "R1", state: "valueChanged", expected: "never" },
            { kind: "popup" },
          ],
        },
        async () => {}
      );
    } catch (error) {
      timeout = error as AgentProtocolError;
    }
    expect(timeout).toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(JSON.stringify(timeout?.details).length).toBeLessThanOrEqual(16_000);
    expect(timeout?.details).toMatchObject({
      events: expect.any(Object),
      observations: expect.any(Array),
    });
  });

  it(
    "returns a Chromium target id when available and never treats a detached ref as disabled",
    { timeout: 30_000 },
    async () => {
      const page = await manager.getPage("wait-regression", "popup-target-id");
      await page.goto(fixture.mainUrl);
      const popup = await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 3_000,
          conditions: [{ kind: "popup" }],
        },
        () => page.locator("[data-testid=popup-link]").click()
      );
      expect(popup.waitResult.events.popup[0]?.targetId).toMatch(/^[A-Fa-f0-9]+$/);

      await page.setContent('<button data-dev-browser-ref="R1">remove me</button>');
      await expect(
        runWithWait(
          page,
          { collect: async () => null },
          {
            mode: "all",
            timeoutMs: 25,
            conditions: [{ kind: "ref", ref: "R1", state: "disabled" }],
          },
          () => page.evaluate(() => document.querySelector("button")!.remove())
        )
      ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    }
  );
});
