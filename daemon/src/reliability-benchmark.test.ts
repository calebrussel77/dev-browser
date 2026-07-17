import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction } from "./interactive-actions.js";
import { getRecordedState } from "./page-state.js";
import { collectPageState } from "./perception/collector.js";
import { startAgentReliabilityFixture, type AgentReliabilityFixture } from "./test-fixtures/agent-reliability-fixture.js";

describe.sequential("maintained agent reliability benchmark", () => {
  const browser = "reliability-benchmark";
  const pageName = "fixture";
  let root = "";
  let manager: BrowserManager;
  let fixture: AgentReliabilityFixture;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-benchmark-"));
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser(browser, { headless: true });
    fixture = await startAgentReliabilityFixture();
    const page = await manager.getPage(browser, pageName);
    await page.goto(fixture.mainUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const counters = window as unknown as { __benchmarkMainClicks: number; __benchmarkDecoyClicks: number };
      counters.__benchmarkMainClicks = 0;
      counters.__benchmarkDecoyClicks = 0;
      document.querySelector("[data-testid=connect-main]")?.addEventListener("click", () => { counters.__benchmarkMainClicks += 1; });
      document.querySelector("aside button")?.addEventListener("click", () => { counters.__benchmarkDecoyClicks += 1; });
    });
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, root);
    await fixture.close();
  }, 180_000);

  it("completes at least 95 percent with zero wrong targets or duplicate submissions", async () => {
    const page = await manager.getPage(browser, pageName);
    const latencies: number[] = [];
    let completed = 0;
    const workflows = 20;

    for (let index = 0; index < workflows; index += 1) {
      const started = performance.now();
      const found = await executeInteractiveAction(manager, {
        id: `benchmark-find-${index}`, type: "interactive", protocolVersion: 2,
        browser, page: pageName,
        action: { kind: "find", role: "button", name: "Connect", nameMode: "exact", within: "main", scope: "document", states: [], limit: 5 },
      });
      const target = found.matches?.[0];
      if (!target) continue;
      await executeInteractiveAction(manager, {
        id: `benchmark-click-${index}`, type: "interactive", protocolVersion: 2,
        browser, page: pageName,
        action: { kind: "click", ref: target.ref, fromState: found.stateId, method: "mouse", retry: "never" },
      });
      const mainClicks = await page.evaluate(() => (window as unknown as { __benchmarkMainClicks: number }).__benchmarkMainClicks);
      if (mainClicks === index + 1) completed += 1;
      latencies.push(performance.now() - started);
    }

    const counters = await page.evaluate(() => ({
      main: (window as unknown as { __benchmarkMainClicks: number }).__benchmarkMainClicks,
      decoy: (window as unknown as { __benchmarkDecoyClicks: number }).__benchmarkDecoyClicks,
    }));
    const observed = await executeInteractiveAction(manager, {
      id: "benchmark-observe", type: "interactive", protocolVersion: 2,
      browser, page: pageName,
      action: { kind: "observe", full: false, delta: false, track: "benchmark", maxNodes: 100, maxChars: 12_000, depth: 12, breadth: 50 },
    });
    expect(completed / workflows).toBeGreaterThanOrEqual(0.95);
    expect(counters.decoy).toBe(0);
    expect(counters.main).toBe(completed);
    expect(JSON.stringify(observed).length).toBeLessThan(100_000);
    expect(Math.max(...latencies)).toBeLessThan(10_000);
  }, 180_000);

  it("measures large-page perception, delta size, memory growth, action latency, and registry cleanup", async () => {
    const page = await manager.getPage(browser, pageName);
    await page.setContent(`<main><button id="action">Act</button>${Array.from({ length: 2_000 }, (_, index) => `<button data-row="${index}">Row ${index}</button>`).join("")}</main>`);
    const observe = (delta: boolean, track = "large") => executeInteractiveAction(manager, {
      id: `benchmark-large-${delta}-${Date.now()}`, type: "interactive" as const, protocolVersion: 2 as const,
      browser, page: pageName,
      action: { kind: "observe" as const, full: false, delta, track, maxNodes: 1_000, maxChars: 100_000, depth: 12, breadth: 500 },
    });

    setFlagsFromString("--expose_gc");
    const collectGarbage = runInNewContext("gc") as () => void;
    collectGarbage();
    const heapBefore = process.memoryUsage().heapUsed;
    const observeStarted = performance.now();
    const full = await observe(false);
    const observeLatencyMs = performance.now() - observeStarted;
    const firstState = full.stateId!;
    for (let index = 0; index < 24; index += 1) await observe(false, `memory-${index % 2}`);
    collectGarbage();
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    await collectPageState(page, { delta: false, track: "delta-measure", maxNodes: 1_000, maxChars: 100_000, depth: 12, breadth: 500 });
    await page.locator("[data-row='0']").evaluate((element) => { element.textContent = "Row changed"; });
    const delta = await collectPageState(page, { delta: true, track: "delta-measure", maxNodes: 1_000, maxChars: 100_000, depth: 12, breadth: 500 });
    const fullSize = JSON.stringify(full).length;
    const deltaSize = JSON.stringify(delta.delta ?? {}).length;

    const actionState = await executeInteractiveAction(manager, {
      id: "benchmark-large-find", type: "interactive", protocolVersion: 2,
      browser, page: pageName,
      action: { kind: "find", role: "button", name: "Act", nameMode: "exact", scope: "visible", states: [], limit: 1 },
    });
    const actionStarted = performance.now();
    await executeInteractiveAction(manager, {
      id: "benchmark-large-click", type: "interactive", protocolVersion: 2,
      browser, page: pageName,
      action: { kind: "click", ref: actionState.matches![0]!.ref, fromState: actionState.stateId, method: "mouse", retry: "never" },
    });
    const actionLatencyMs = performance.now() - actionStarted;

    await page.setContent("<main><button>small</button></main>");
    for (let index = 0; index < 105; index += 1) await observe(false, "cleanup");

    expect(observeLatencyMs).toBeLessThan(10_000);
    expect(actionLatencyMs).toBeLessThan(10_000);
    expect(fullSize).toBeLessThan(500_000);
    expect(deltaSize).toBeLessThan(fullSize);
    expect(delta.delta?.changed.length).toBeGreaterThan(0);
    expect(heapGrowth).toBeLessThan(128 * 1024 * 1024);
    expect(getRecordedState(page, firstState)).toBeUndefined();
  }, 180_000);
});
