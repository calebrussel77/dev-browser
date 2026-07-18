import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction } from "./interactive-actions.js";

const browserName = "scoped-revalidation";
const pageName = "budget";
// Enough header candidates to exhaust the default 100-node display budget
// before collection ever reaches main, mirroring a heavy real-world page
// (the LinkedIn acceptance run's gap 1 shape).
const headerFillerCount = 150;

function request(
  action: Parameters<typeof executeInteractiveAction>[1]["action"]
): Parameters<typeof executeInteractiveAction>[1] {
  return {
    id: `test-${action.kind}`,
    type: "interactive",
    browser: browserName,
    page: pageName,
    protocolVersion: 2,
    action,
  };
}

function observeAction(within?: string) {
  return {
    kind: "observe" as const,
    full: false,
    delta: false,
    track: "default",
    maxNodes: 100,
    maxChars: 12_000,
    depth: 12,
    breadth: 50,
    ...(within ? { within } : {}),
  };
}

describe.sequential("scoped observe → act on pages heavier than the default budgets", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  async function loadHeavyPage() {
    const page = await manager.getPage(browserName, pageName);
    const filler = Array.from(
      { length: headerFillerCount },
      (_, index) => `<p>Header filler ${index}</p>`
    ).join("");
    await page.setContent(`
      <header>${filler}</header>
      <main>
        <button id="deep-action">Deep action</button>
        <input id="deep-input" aria-label="Deep input">
        <output id="deep-result">idle</output>
      </main>
      <script>
        window.__deepClicks = 0;
        document.querySelector('#deep-action').addEventListener('click', () => {
          window.__deepClicks += 1;
          document.querySelector('#deep-result').textContent = 'clicked';
        });
      </script>
    `);
    return page;
  }

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-scoped-revalidation-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
    await loadHeavyPage();
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, browserRootDir);
  }, 180_000);

  it("confirms the fixture shape: unscoped default budgets never reach main's elements", async () => {
    const unscoped = await executeInteractiveAction(manager, request(observeAction()));
    expect(unscoped.tree).toContain("Header filler");
    expect(unscoped.elements?.some((element) => element.name === "Deep action")).toBe(false);
  });

  it("clicks a ref from a scoped observe with --from-state instead of reporting STALE_REF", async () => {
    const observed = await executeInteractiveAction(manager, request(observeAction("main")));
    const ref = observed.elements?.find((element) => element.name === "Deep action")?.ref;
    expect(ref).toMatch(/^R\d+$/);

    const clicked = await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: ref!, method: "mouse", fromState: observed.stateId })
    );

    expect(clicked.clicked?.ref).toBe(ref);
    const page = await manager.getPage(browserName, pageName);
    expect(await page.evaluate(() => (window as unknown as { __deepClicks: number }).__deepClicks)).toBe(1);
  });

  it("types into a ref from a scoped observe without --from-state via the recorded scope", async () => {
    const observed = await executeInteractiveAction(manager, request(observeAction("main")));
    const ref = observed.elements?.find((element) => element.name === "Deep input")?.ref;
    expect(ref).toMatch(/^R\d+$/);

    const typed = await executeInteractiveAction(
      manager,
      request({ kind: "type", ref: ref!, text: "reached deep", clear: true, delayMs: 0 })
    );

    expect(typed.typed?.characters).toBe("reached deep".length);
    const page = await manager.getPage(browserName, pageName);
    expect(
      await page.evaluate(() => (document.querySelector("#deep-input") as HTMLInputElement).value)
    ).toBe("reached deep");
  });

  it("find --within scopes its collection so mid-page elements beyond the budget match", async () => {
    const unscoped = await executeInteractiveAction(
      manager,
      request({
        kind: "find",
        name: "Deep action",
        nameMode: "contains" as const,
        scope: "document" as const,
        states: [],
        limit: 10,
      })
    );
    expect(unscoped.matches).toHaveLength(0);

    const scoped = await executeInteractiveAction(
      manager,
      request({
        kind: "find",
        name: "Deep action",
        nameMode: "contains" as const,
        within: "main",
        scope: "document" as const,
        states: [],
        limit: 10,
      })
    );
    expect(scoped.matches?.[0]).toEqual(
      expect.objectContaining({ name: "Deep action", landmark: expect.stringContaining("main") })
    );
  });

  it("falls back to a typed STALE_REF when the originating scope root is gone", async () => {
    const observed = await executeInteractiveAction(manager, request(observeAction("main")));
    const ref = observed.elements?.find((element) => element.name === "Deep action")?.ref;
    const page = await manager.getPage(browserName, pageName);
    await page.evaluate(() => document.querySelector("main")?.remove());
    try {
      await expect(
        executeInteractiveAction(
          manager,
          request({ kind: "click", ref: ref!, method: "mouse", fromState: observed.stateId })
        )
      ).rejects.toMatchObject({ code: "STALE_REF", recoverable: true });
    } finally {
      await loadHeavyPage();
    }
  });
});
