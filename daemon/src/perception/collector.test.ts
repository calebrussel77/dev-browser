import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPageState } from "./collector.js";

describe.sequential("unified page perception", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("keeps duplicate accessible names attached to distinct inline refs without DOM mutations", async () => {
    await page.setContent(`
      <main><h1>Accounts</h1><button>Connect</button></main>
      <aside><button>Connect</button></aside>
    `);

    const state = await collectPageState(page, { track: "duplicates" });
    const connects = state.elements.filter(
      (element) => element.actionable && element.name === "Connect"
    );

    expect(connects).toHaveLength(2);
    expect(connects[0]?.ref).toMatch(/^R\d+$/);
    expect(connects[1]?.ref).toMatch(/^R\d+$/);
    expect(connects[0]?.ref).not.toBe(connects[1]?.ref);
    expect(state.tree).toContain(`[${connects[0]?.ref}] button "Connect"`);
    expect(state.tree).toContain(`[${connects[1]?.ref}] button "Connect"`);
    expect(await page.locator("[data-dev-browser-ref]").count()).toBe(0);
  });

  it("reports focus, safe control state, context, and CSS scroll coordinates", async () => {
    await page.setContent(`
      <main><section><h2>Profile</h2><label for="name">Display name</label>
      <input id="name" value="Ada" placeholder="Your name" required aria-describedby="hint">
      <span id="hint">Public name</span><input type="password" value="secret"></section></main>
      <div style="height: 1400px"></div>
    `);
    await page.locator("#name").focus();
    await page.evaluate(() => scrollTo(0, 120));

    const state = await collectPageState(page, { full: true, track: "metadata" });
    const input = state.elements.find(
      (element) => element.actionable && element.name === "Display name"
    );
    const password = state.elements.find((element) => element.value === "[redacted]");

    expect(state.focusedRef).toBe(input?.ref);
    expect(input).toMatchObject({
      role: "textbox",
      description: "Public name",
      required: true,
      value: "Ada",
      placeholder: "Your name",
      focused: true,
      nearby: { heading: "Profile", label: "Display name" },
      frameId: "F0",
      shadowContext: [],
    });
    expect(password?.value).toBe("[redacted]");
    expect(state.coordinateSpace).toMatchObject({
      unit: "css-px",
      viewport: { width: 800, height: 600 },
      scroll: { x: 0, y: 120 },
      screenshotScale: "css",
    });
  });

  it("reports compact deltas while stable targets remain unchanged", async () => {
    await page.setContent(
      `<main><button id="stable">Stable</button><button id="change">Before</button></main>`
    );
    const first = await collectPageState(page, { delta: true, track: "changes" });
    const stableRef = first.elements.find((element) => element.name === "Stable")?.ref;
    const changedRef = first.elements.find((element) => element.name === "Before")?.ref;
    await page.evaluate(() => {
      document.querySelector("#change")!.textContent = "After";
      const added = document.createElement("button");
      added.textContent = "Added";
      document.querySelector("main")!.append(added);
    });

    const second = await collectPageState(page, { delta: true, track: "changes" });

    expect(second.documentId).toBe(first.documentId);
    expect(second.stateId).not.toBe(first.stateId);
    expect(second.delta?.changed).toContain(changedRef);
    expect(second.delta?.changed).not.toContain(stableRef);
    expect(second.delta?.added).toContain(
      second.elements.find((element) => element.name === "Added")?.ref
    );
  });

  it("makes compact/full output distinct and exposes deterministic budget cursors", async () => {
    await page.setContent(
      `<main><section><h2>Form</h2>${Array.from(
        { length: 8 },
        (_, index) => `<label>Field ${index}<input value="value-${index}"></label>`
      ).join("")}</section></main>`
    );
    const compact = await collectPageState(page, { track: "compact" });
    const full = await collectPageState(page, { full: true, track: "full" });
    const limited = await collectPageState(page, {
      maxNodes: 3,
      maxChars: 200,
      depth: 2,
      breadth: 4,
      track: "limited",
    });

    expect(compact.elements.some((element) => element.value !== undefined)).toBe(false);
    expect(full.elements.some((element) => element.value === "value-0")).toBe(true);
    expect(limited.elements.length).toBeLessThanOrEqual(3);
    expect(limited.tree.length).toBeLessThanOrEqual(200);
    expect(limited.truncation).toEqual({
      truncated: true,
      omittedNodes: expect.any(Number),
      continuation: expect.any(String),
    });
    const continued = await collectPageState(page, {
      maxNodes: 3,
      maxChars: 200,
      depth: 2,
      breadth: 4,
      continuation: limited.truncation.continuation!,
      track: "limited",
    });
    expect(continued.tree).not.toBe(limited.tree);
  });

  it("follows every truncation cursor without dropping or duplicating oversized deep nodes", async () => {
    await page.setContent(`
      <main>
        <section><div><button>Alpha oversized action</button></div></section>
        <section><div><button>Beta oversized action</button></div></section>
        <section><div><button>Gamma oversized action</button></div></section>
      </main>
    `);
    const signature = (element: { ref: string; role: string; name: string; landmark: string }) =>
      `${element.ref}|${element.role}|${element.name}|${element.landmark}`;
    const expected = (
      await collectPageState(page, { maxNodes: 100, maxChars: 100_000, track: "all-nodes" })
    ).elements.map(signature);
    const seen: string[] = [];
    const actionableNames: string[] = [];
    let continuation: string | undefined;
    do {
      const state = await collectPageState(page, {
        maxNodes: 2,
        maxChars: 12,
        depth: 1,
        breadth: 1,
        continuation,
        track: "paginate-all",
      });
      seen.push(...state.elements.map(signature));
      actionableNames.push(
        ...state.elements.filter((element) => element.actionable).map((element) => element.name)
      );
      continuation = state.truncation.continuation ?? undefined;
    } while (continuation);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect(actionableNames).toEqual([
      "Alpha oversized action",
      "Beta oversized action",
      "Gamma oversized action",
    ]);
  });

  it("rejects malformed opaque continuations as typed stale state", async () => {
    await page.setContent(`<button>Continue</button>`);

    await expect(
      collectPageState(page, { continuation: "not-a-real-cursor", track: "invalid-cursor" })
    ).rejects.toMatchObject({ code: "STALE_STATE", recoverable: true });
  });
});
