import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPageState } from "./perception/collector.js";
import { collectLiveSnapshot } from "./live-snapshot.js";
import { runWithWait } from "./wait-engine.js";
import { resolveActionTarget } from "./actionability.js";
import { findTargets } from "./targeting.js";

describe.sequential("scoped frame and shadow waits", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); page = await browser.newPage(); });
  afterAll(async () => { await browser?.close(); });

  it("tracks attached, visible, hidden, and value changes in frames and open roots", async () => {
    await page.setContent(`<iframe srcdoc='<input aria-label="Frame field">'></iframe><div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow field">'</script>`);
    await page.locator("iframe").contentFrame().getByLabel("Frame field").waitFor();
    const state = await collectPageState(page, { full: true });
    const frameRef = state.elements.find((element) => element.name === "Frame field")!.ref;
    const shadowRef = state.elements.find((element) => element.name === "Shadow field")!.ref;
    for (const [ref, locator] of [[frameRef, page.locator("iframe").contentFrame().getByLabel("Frame field")], [shadowRef, page.getByLabel("Shadow field")]] as const) {
      const visible = await runWithWait(page, { collect: async () => null }, { mode: "all", timeoutMs: 500, conditions: [{ kind: "ref", ref, state: "visible" }] }, async () => {});
      expect(visible.waitResult.passed).toHaveLength(1);
      const value = await runWithWait(page, { collect: async () => null }, { mode: "all", timeoutMs: 500, conditions: [{ kind: "ref", ref, state: "valueChanged" }] }, async () => { await locator.fill("changed"); });
      expect(value.waitResult.passed).toHaveLength(1);
      const hidden = await runWithWait(page, { collect: async () => null }, { mode: "all", timeoutMs: 500, conditions: [{ kind: "ref", ref, state: "hidden" }] }, async () => { await locator.evaluate((element) => { (element as HTMLElement).hidden = true; }); });
      expect(hidden.waitResult.passed).toHaveLength(1);
      await locator.evaluate((element) => { (element as HTMLElement).hidden = false; });
    }
  });

  it("treats detached and navigated frame realms as detached old refs", async () => {
    await page.setContent(`<iframe srcdoc='<button>Old realm</button>'></iframe>`);
    const button = page.locator("iframe").contentFrame().getByRole("button"); await button.waitFor();
    let state = await collectPageState(page, { full: true });
    let ref = state.elements.find((element) => element.name === "Old realm")!.ref;
    const navigated = await runWithWait(page, { collect: async () => null }, { mode: "all", timeoutMs: 1_000, conditions: [{ kind: "ref", ref, state: "detached" }] }, async () => { await page.locator("iframe").evaluate((element: HTMLIFrameElement) => { element.srcdoc = '<button>New realm</button>'; }); });
    expect(navigated.waitResult.passed).toHaveLength(1);
    state = await collectPageState(page, { full: true }); ref = state.elements.find((element) => element.name === "New realm")!.ref;
    const detached = await runWithWait(page, { collect: async () => null }, { mode: "all", timeoutMs: 500, conditions: [{ kind: "ref", ref, state: "detached" }] }, async () => { await page.locator("iframe").evaluate((element) => element.remove()); });
    expect(detached.waitResult.passed).toHaveLength(1);
  });

  it("bounds deep and wide live traversal before materializing output", async () => {
    await page.setContent("<main id=root></main>");
    await page.evaluate(() => {
      let parent = document.querySelector("#root")!;
      for (let index = 0; index < 120; index += 1) {
        const child = document.createElement("div");
        parent.append(child);
        parent = child;
      }
    });
    const started = Date.now();
    const snapshot = await collectLiveSnapshot(page);
    expect(snapshot.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    await page.setContent('<button data-testid="target">Known target</button>');
    const observed = await collectPageState(page, { full: true });
    const ref = observed.elements.find((element) => element.name === "Known target")!.ref;
    await page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 1_100; index += 1) fragment.append(document.createElement("div"));
      document.body.prepend(fragment);
    });
    await expect(runWithWait(
      page,
      { collect: async () => null, protocolVersion: 2 },
      { mode: "any", timeoutMs: 80, conditions: [{ kind: "ref", ref, state: "detached" }, { kind: "ref", ref, state: "hidden" }] },
      async () => {}
    )).rejects.toMatchObject({
      code: "WAIT_TIMEOUT",
      details: { observations: [expect.objectContaining({ coverage: "truncated" }), expect.objectContaining({ coverage: "truncated" })] },
    });
  }, 60_000);

  it("keeps truncated ref-transition baselines and text/surface absence unknown", async () => {
    await page.setContent('<input data-testid="target" value="before"><p id="needle">needle beyond cap</p>');
    const observed = await collectPageState(page, { full: true });
    const ref = observed.elements.find((element) => element.stableAttributes.testId === "target")!.ref;
    await page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 1_100; index += 1) fragment.append(document.createElement("div"));
      document.body.prepend(fragment);
    });
    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 2 }, {
      mode: "any", timeoutMs: 100, conditions: [
        { kind: "ref", ref, state: "valueChanged", expected: "after" },
        { kind: "text", state: "hidden", scope: "body", match: "contains", value: "needle beyond cap" },
      ],
    }, async () => {
      await page.evaluate(() => {
        document.querySelectorAll("body > div").forEach((element) => element.remove());
        document.querySelector<HTMLInputElement>('[data-testid="target"]')!.value = "after";
      });
    })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { observations: expect.arrayContaining([expect.objectContaining({ coverage: "truncated", passed: false })]) } });

    await page.setContent(`${Array.from({ length: 1_100 }, () => "<div></div>").join("")}<p>surface cap</p>`);
    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 2 }, {
      mode: "any", timeoutMs: 80, conditions: [
        { kind: "dialog", state: "opened" },
        { kind: "toast", state: "opened" },
      ],
    }, async () => {
      await page.evaluate(() => { document.querySelectorAll("div").forEach((element) => element.remove()); document.body.insertAdjacentHTML("beforeend", '<dialog open>opened</dialog><div role="alert">toast</div>'); });
    })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { observations: [expect.objectContaining({ coverage: "truncated" }), expect.objectContaining({ coverage: "truncated" })] } });
  });

  it("collects bounded nested dialog and toast text across top, frame, and shadow realms", async () => {
    await page.setContent('<iframe></iframe><div id="host"></div>');
    await page.locator("#host").evaluate((host) => host.attachShadow({ mode: "open" }));
    await collectPageState(page, { full: true });
    const result = await runWithWait(page, { collect: async () => null, protocolVersion: 2 }, {
      mode: "all", timeoutMs: 500, conditions: [
        { kind: "text", state: "visible", scope: "dialog", match: "contains", value: "Top Saved" },
        { kind: "text", state: "visible", scope: "dialog", match: "contains", value: "Frame Saved" },
        { kind: "text", state: "visible", scope: "toast", match: "contains", value: "Shadow Saved" },
      ],
    }, async () => {
      await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<dialog open><span>Top <b>Saved</b></span></dialog>'));
      await page.locator("iframe").contentFrame().locator("body").evaluate((body) => { body.innerHTML = '<div role="dialog"><span>Frame <b>Saved</b></span></div>'; });
      await page.locator("#host").evaluate((host) => { host.shadowRoot!.innerHTML = '<div role="status"><span>Shadow <b>Saved</b></span></div>'; });
    });
    expect(result.waitResult.passed).toHaveLength(3);

    await page.setContent('<dialog open id="huge"></dialog>');
    await page.locator("#huge").evaluate((surface) => { for (let index = 0; index < 1_100; index += 1) { const span = document.createElement("span"); span.textContent = index === 1_099 ? "Saved beyond surface cap" : "filler"; surface.append(span); } });
    await collectPageState(page, { full: true });
    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 2 }, { mode: "all", timeoutMs: 80, conditions: [{ kind: "text", state: "visible", scope: "dialog", match: "contains", value: "Saved beyond surface cap" }] }, async () => {})).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { observations: [expect.objectContaining({ coverage: "truncated", passed: false })] } });
  });

  it("marks global surface slicing across top and frames as truncated before absence checks", async () => {
    await page.setContent('<main id="top"></main><iframe></iframe><iframe></iframe>');
    const frames = page.locator("iframe");
    const surfaces = (prefix: string, start: number) => Array.from({ length: 20 }, (_, index) => `<div role="dialog"><span>${prefix} ${start + index}</span></div><div role="status"><span>toast ${start + index}</span></div>`).join("");
    await page.locator("#top").evaluate((top, html) => { top.innerHTML = html; }, surfaces("dialog", 0));
    await frames.nth(0).contentFrame().locator("body").evaluate((body, html) => { body.innerHTML = html; }, surfaces("dialog", 20));
    await frames.nth(1).contentFrame().locator("body").evaluate((body, html) => { body.innerHTML = html; }, surfaces("dialog", 40));
    await collectPageState(page, { full: true });
    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 2 }, { mode: "any", timeoutMs: 80, conditions: [
      { kind: "text", state: "hidden", scope: "dialog", match: "contains", value: "dialog 59" },
      { kind: "dialog", state: "closed" },
    ] }, async () => { await frames.nth(1).contentFrame().getByText("dialog 59").evaluate((element) => element.closest('[role="dialog"]')!.remove()); })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { observations: [expect.objectContaining({ coverage: "truncated" }), expect.objectContaining({ coverage: "truncated" })] } });

    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 2 }, { mode: "all", timeoutMs: 80, conditions: [{ kind: "toast", state: "opened" }] }, async () => { await page.locator("#top").evaluate((top) => top.insertAdjacentHTML("beforeend", '<div role="status"><span>toast 60</span></div>')); })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { observations: [expect.objectContaining({ coverage: "truncated" })] } });
  });

  it.each(["display-none", "visibility-hidden", "zero-size", "transparent-wrapper"])("inherits %s frame visibility across observe, find, waits, and actions", async (mode) => {
    await page.setContent(`<div id="wrapper"><iframe id="outer" style="width:300px;height:180px"></iframe></div>`);
    const outer = page.locator("#outer").contentFrame();
    await outer.locator("body").evaluate((body) => { body.innerHTML = '<iframe style="width:200px;height:100px" srcdoc="<button>Nested visibility target</button>"></iframe>'; });
    await outer.locator("iframe").contentFrame().getByRole("button").waitFor();
    const before = await collectPageState(page, { full: true });
    const target = before.elements.find((element) => element.name === "Nested visibility target")!;
    await page.locator("#outer").evaluate((element, selected) => {
      const frame = element as HTMLElement;
      if (selected === "display-none") frame.style.display = "none";
      else if (selected === "visibility-hidden") frame.style.visibility = "hidden";
      else if (selected === "zero-size") { frame.style.width = "0"; frame.style.height = "0"; frame.style.border = "0"; }
      else document.querySelector<HTMLElement>("#wrapper")!.style.opacity = "0";
    }, mode);
    const hidden = await collectPageState(page, { full: true });
    const hiddenTarget = hidden.elements.find((element) => element.ref === target.ref)!;
    expect(hiddenTarget).toMatchObject({ visible: false, actionable: false, inViewport: false, box: { width: 0, height: 0 } });
    expect(findTargets(hidden.elements, { name: "Nested visibility target", nameMode: "exact", scope: "visible", states: [] }, 5).matches).toEqual([]);
    const waited = await runWithWait(page, { collect: async () => null, protocolVersion: 2 }, { mode: "all", timeoutMs: 200, conditions: [{ kind: "ref", ref: target.ref, state: "hidden" }, { kind: "ref", ref: target.ref, state: "attached" }] }, async () => {});
    expect(waited.waitResult.passed).toHaveLength(2);
    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 2 }, { mode: "all", timeoutMs: 60, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "Nested visibility target" }] }, async () => {})).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    await expect(resolveActionTarget(page, target.ref, { timeoutMs: 200, scroll: false, hitTest: true, applicability: "pointer" })).rejects.toMatchObject({ code: "TARGET_HIDDEN" });
  }, 20_000);

  it("keeps protocol v1 waits top-document light-DOM and honors legacy refs without observe", async () => {
    await page.setContent('<div id="host"></div><iframe srcdoc="<button data-dev-browser-ref=R2>Frame legacy</button>"></iframe>');
    await page.locator("#host").evaluate((host) => { host.attachShadow({ mode: "open" }).innerHTML = '<button data-dev-browser-ref="R3">Shadow legacy</button>'; });
    const attached = await runWithWait(page, { collect: async () => null, protocolVersion: 1 }, { mode: "all", timeoutMs: 300, conditions: [{ kind: "ref", ref: "R1", state: "attached" }] }, async () => {
      await page.evaluate(() => document.body.insertAdjacentHTML("afterbegin", '<button data-dev-browser-ref="R1">Top legacy</button>'));
    });
    expect(attached.waitResult.passed).toHaveLength(1);
    await expect(runWithWait(page, { collect: async () => null, protocolVersion: 1 }, { mode: "any", timeoutMs: 60, conditions: [{ kind: "ref", ref: "R2", state: "attached" }, { kind: "ref", ref: "R3", state: "attached" }] }, async () => {})).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
  }, 20_000);
});
