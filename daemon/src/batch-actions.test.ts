import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeBatchActions } from "./batch-actions.js";
import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction } from "./interactive-actions.js";
import type { BatchRequest } from "./protocol.js";

describe.sequential("batch actions", () => {
  const browser = "batch-actions";
  const pageName = "fixture";
  let root = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-batch-"));
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser(browser, { headless: true });
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, root);
  }, 180_000);

  it("runs find, semantic click, and assert sequentially", async () => {
    const page = await manager.getPage(browser, pageName);
    await page.setContent(`
      <main><button id="main">Connect</button><p id="status"></p></main>
      <aside><button id="decoy">Connect</button></aside>
      <script>
        window.__mainClicks = 0;
        window.__decoyClicks = 0;
        document.querySelector('#main').addEventListener('click', () => {
          window.__mainClicks += 1;
          document.querySelector('#status').textContent = 'Connected safely';
        });
        document.querySelector('#decoy').addEventListener('click', () => window.__decoyClicks += 1);
      </script>
    `);

    const result = await executeBatchActions(manager, {
      id: "batch-success",
      type: "batch",
      protocolVersion: 2,
      browser,
      page: pageName,
      stopOnError: true,
      observeAfter: "delta",
      steps: [
        {
          kind: "find", role: "button", name: "Connect", nameMode: "exact",
          within: "main", scope: "visible", states: [], limit: 5,
        },
        {
          kind: "click", role: "button", name: "Connect", nameMode: "exact",
          within: "main", states: [], method: "mouse", strictState: false,
        },
        { kind: "assert", within: "main", text: "Connected safely", match: "contains" },
      ],
    } as BatchRequest);

    expect(result.firstError).toBeUndefined();
    expect(result.steps.map((step) => [step.kind, step.ok])).toEqual([
      ["find", true],
      ["click", true],
      ["assert", true],
    ]);
    expect(result.final?.stateId).toMatch(/^doc-\d+:\d+$/);
    await expect(page.evaluate(() => ({
      main: (window as unknown as { __mainClicks: number }).__mainClicks,
      decoy: (window as unknown as { __decoyClicks: number }).__decoyClicks,
    }))).resolves.toEqual({ main: 1, decoy: 0 });
  });

  it("stops after an invalid confirmation token", async () => {
    const page = await manager.getPage(browser, pageName);
    await page.setContent(`
      <main>
        <button id="guarded">Guarded action</button>
        <button id="after">After action</button>
      </main>
      <script>
        window.__guardedClicks = 0;
        window.__afterClicks = 0;
        document.querySelector('#guarded').addEventListener('click', () => window.__guardedClicks += 1);
        document.querySelector('#after').addEventListener('click', () => window.__afterClicks += 1);
      </script>
    `);
    const found = await executeInteractiveAction(manager, {
      id: "batch-guard-find", type: "interactive", protocolVersion: 2,
      browser, page: pageName,
      action: {
        kind: "find", role: "button", name: "Guarded action", nameMode: "exact",
        scope: "visible", states: [], limit: 1,
      },
    });

    const result = await executeBatchActions(manager, {
      id: "batch-failure",
      type: "batch",
      protocolVersion: 2,
      browser,
      page: pageName,
      stopOnError: true,
      observeAfter: "delta",
      steps: [
        {
          kind: "click", ref: found.matches![0]!.ref, fromState: found.stateId,
          confirmToken: "x".repeat(32), method: "mouse", strictState: false,
        },
        {
          kind: "click", role: "button", name: "After action", nameMode: "exact",
          within: "main", states: [], method: "mouse", strictState: false,
        },
      ],
    } as BatchRequest);

    expect(result.firstError).toMatchObject({ code: "CONFIRMATION_INVALID" });
    expect(result.final).toBeUndefined();
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ ok: false, error: { code: "CONFIRMATION_INVALID" } });
    await expect(page.evaluate(() => ({
      guarded: (window as unknown as { __guardedClicks: number }).__guardedClicks,
      after: (window as unknown as { __afterClicks: number }).__afterClicks,
    }))).resolves.toEqual({ guarded: 0, after: 0 });
  });
});
