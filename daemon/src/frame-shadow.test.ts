import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPageState } from "./perception/collector.js";
import { resolveActionTarget } from "./actionability.js";
import { captureVisualArtifacts } from "./visual-artifacts.js";
import { rm } from "node:fs/promises";

describe.sequential("frame and shadow perception", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("observes attached frames and nested open shadow roots with contextual refs", async () => {
    await page.setContent(`
      <main><button>Main duplicate</button></main>
      <iframe title="Child" style="margin:40px;border:4px solid black;width:300px;height:180px"
        srcdoc='<button aria-label="Frame duplicate">Frame duplicate</button>'></iframe>
      <div id="host"></div><div id="closed-shadow"></div>
      <script>
        const first = document.querySelector('#host').attachShadow({mode:'open'});
        first.innerHTML = '<section><div id="nested"></div></section>';
        const second = first.querySelector('#nested').attachShadow({mode:'open'});
        second.innerHTML = '<button aria-label="Nested shadow action">Nested shadow action</button>';
        document.querySelector('#closed-shadow').attachShadow({mode:'closed'}).innerHTML = '<button>Closed action</button>';
      </script>
    `);
    await page.locator("iframe").contentFrame().getByRole("button").waitFor();

    const state = await collectPageState(page, { full: true });
    const frame = state.elements.find((element) => element.name === "Frame duplicate")!;
    const shadow = state.elements.find((element) => element.name === "Nested shadow action")!;

    expect(frame).toMatchObject({ frameId: "F1", framePath: ["F0", "F1"] });
    expect(frame.ref).toMatch(/^F1:R\d+$/);
    expect(frame.box.x).toBeGreaterThan(40);
    expect(shadow.ref).toMatch(/^R\d+$/);
    expect(shadow.shadowContext).toHaveLength(2);
    expect(shadow.shadowContext[0]).toContain("#host");
    expect(state.tree).toContain(`[${frame.ref}] button "Frame duplicate"`);
    expect(state.warnings).toEqual([
      expect.stringMatching(/closed shadow root/i),
    ]);
    expect(await page.locator("[data-dev-browser-ref]").count()).toBe(0);
  });

  it("keeps frame CSS boxes aligned with Playwright at DPR2 after top and frame scroll", async () => {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 260, deviceScaleFactor: 2, mobile: false });
    try {
      await page.setContent(`
        <style>html,body{margin:0}.sticky{position:sticky;top:0;height:32px;background:red;z-index:3}.spacer{height:220px}iframe{margin-left:35px;border:6px solid black;width:240px;height:130px;transform:scale(1.1);transform-origin:top left}</style>
        <div class="sticky">sticky</div><div class="spacer"></div>
        <iframe title="Offset frame" srcdoc='<style>body{margin:0;height:400px}button{margin:90px 0 0 25px;width:80px;height:30px}</style><button>Offset action</button><script>scrollTo(0,40)<\/script>'></iframe>
      `);
      await page.locator("iframe").contentFrame().getByRole("button").waitFor();
      await page.evaluate(() => scrollTo(0, 180));
      const state = await collectPageState(page, { full: true });
      const target = state.elements.find((element) => element.name === "Offset action")!;
      const playwrightBox = await page.locator("iframe").contentFrame().getByRole("button").boundingBox();
      expect(target.box.x).toBeCloseTo(playwrightBox!.x, 0);
      expect(target.box.y).toBeCloseTo(playwrightBox!.y, 0);
      expect(target.box.width).toBeCloseTo(playwrightBox!.width, 0);
      expect(state.coordinateSpace.devicePixelRatio).toBe(2);
      expect(state.coordinateSpace.scroll.y).toBeGreaterThan(100);
    } finally {
      await session.send("Emulation.clearDeviceMetricsOverride");
      await session.detach();
    }
  });

  it("paginates combined frame and shadow records without gaps or duplicates", async () => {
    await page.setContent(`<main>${Array.from({ length: 4 }, (_, index) => `<button>Main ${index}</button>`).join("")}</main>
      <iframe srcdoc='${Array.from({ length: 4 }, (_, index) => `<button>Frame ${index}</button>`).join("")}'></iframe>`);
    await page.locator("iframe").contentFrame().getByRole("button").first().waitFor();
    const refs: string[] = [];
    let continuation: string | undefined;
    do {
      const state = await collectPageState(page, { maxNodes: 3, continuation });
      refs.push(...state.elements.filter((element) => element.actionable).map((element) => element.ref));
      continuation = state.truncation.continuation ?? undefined;
    } while (continuation);
    expect(refs).toHaveLength(8);
    expect(new Set(refs).size).toBe(8);
    expect(refs.some((ref) => /^F\d+:R/.test(ref))).toBe(true);
  });

  it("returns FRAME_DETACHED with recovery when a registered child disappears", async () => {
    await page.setContent(`<iframe srcdoc='<button>Detach action</button>'></iframe>`);
    await page.locator("iframe").contentFrame().getByRole("button").waitFor();
    const state = await collectPageState(page, { full: true });
    const ref = state.elements.find((element) => element.name === "Detach action")!.ref;
    await page.locator("iframe").evaluate((element) => element.remove());
    await expect(resolveActionTarget(page, ref, {
      pageName: "detached-frame", timeoutMs: 200, scroll: false, hitTest: true, applicability: "pointer",
    })).rejects.toMatchObject({ code: "FRAME_DETACHED", nextCommands: [expect.stringContaining("detached-frame")] });
  });

  it("keeps existing frame IDs stable when a new earlier sibling attaches", async () => {
    await page.setContent(`<main><iframe title="First" srcdoc='<button>First action</button>'></iframe><iframe title="Second" srcdoc='<button>Second action</button>'></iframe></main>`);
    await page.getByTitle("Second").contentFrame().getByRole("button").waitFor();
    const before = await collectPageState(page, { full: true });
    const ids = Object.fromEntries(before.elements.filter((element) => /^(First|Second) action$/.test(element.name)).map((element) => [element.name, element.frameId]));
    await page.locator("main").evaluate((main) => main.insertAdjacentHTML("afterbegin", `<iframe title="Inserted" srcdoc='<button>Inserted action</button>'></iframe>`));
    await page.getByTitle("Inserted").contentFrame().getByRole("button").waitFor();
    const after = await collectPageState(page, { full: true });
    expect(after.elements.find((element) => element.name === "First action")?.frameId).toBe(ids["First action"]);
    expect(after.elements.find((element) => element.name === "Second action")?.frameId).toBe(ids["Second action"]);
    expect(after.elements.find((element) => element.name === "Inserted action")?.frameId).not.toBe(ids["First action"]);
  });

  it("detects a top-document overlay obstructing a child-frame target", async () => {
    await page.setContent(`<style>html,body{margin:0}iframe{position:absolute;left:20px;top:20px;width:200px;height:100px}.cover{position:absolute;left:20px;top:20px;width:200px;height:100px;z-index:2;background:red}</style>
      <iframe srcdoc='<button style="margin:25px;width:120px;height:40px">Covered frame action</button>'></iframe><div class="cover">cover</div>`);
    await page.locator("iframe").contentFrame().getByRole("button").waitFor();
    const state = await collectPageState(page, { full: true });
    const target = state.elements.find((element) => element.name === "Covered frame action")!;
    expect(target.obscured).toBe(true);
    await expect(resolveActionTarget(page, target.ref, {
      pageName: "covered-frame", timeoutMs: 300, scroll: false, hitTest: true, applicability: "pointer",
    })).rejects.toMatchObject({ code: "TARGET_OBSCURED" });
  });

  it("projects nested rotated and skewed frame quads for DPR2 screenshot crop and xy input", async () => {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
    try {
      await page.setContent(`<style>html,body{margin:0}#outer{margin:100px;width:420px;height:260px;border:7px solid;transform:rotate(7deg) skewX(4deg);transform-origin:30% 20%}</style><iframe id="outer"></iframe>`);
      const outer = page.locator("#outer").contentFrame();
      await outer.locator("body").evaluate((body) => { body.innerHTML = '<style>html,body{margin:0}iframe{margin:45px;width:260px;height:140px;border:5px solid;transform:skewY(6deg) scale(.9);transform-origin:center}</style><iframe></iframe>'; });
      const inner = outer.locator("iframe").contentFrame();
      await inner.locator("body").evaluate((body) => { body.innerHTML = '<button style="margin:30px;width:100px;height:44px">Affine action</button><output>clicks:0</output>'; body.querySelector("button")!.addEventListener("click", () => { body.querySelector("output")!.textContent = "clicks:1"; }); });
      const targetLocator = inner.getByRole("button");
      await targetLocator.waitFor();
      const state = await collectPageState(page, { full: true, maxNodes: 1_000, breadth: 500 });
      const target = state.elements.find((element) => element.name === "Affine action")!;
      const playwright = await targetLocator.boundingBox();
      expect(target.quad).toHaveLength(4);
      expect(target.box.x).toBeCloseTo(playwright!.x, 0);
      expect(target.box.y).toBeCloseTo(playwright!.y, 0);
      expect(target.box.width).toBeCloseTo(playwright!.width, 0);
      const resolved = await resolveActionTarget(page, target.ref, { pageName: "affine", timeoutMs: 500, scroll: false, hitTest: true, applicability: "pointer" });
      await page.mouse.click(resolved.box.x + resolved.box.width / 2, resolved.box.y + resolved.box.height / 2);
      await resolved.cleanup();
      expect(await inner.locator("output").textContent()).toBe("clicks:1");
      const artifacts = await captureVisualArtifacts(page, state, { screenshotName: `frame-affine-${Date.now()}.png`, fullPage: true, focus: { box: target.box, padding: 20 } });
      expect(artifacts.screenshot).toMatchObject({ mode: "crop", coordinateSpace: { devicePixelRatio: 2 } });
      await rm(artifacts.screenshot!.path, { force: true });
    } finally { await session.send("Emulation.clearDeviceMetricsOverride"); await session.detach(); }
  }, 20_000);

  it("resets frame IDs on top-document generation and orders shadow-hosted frames by composed DOM path", async () => {
    await page.goto(`data:text/html,<iframe srcdoc='<button>First generation</button>'></iframe>`);
    await page.locator("iframe").contentFrame().getByRole("button").waitFor();
    let state = await collectPageState(page, { full: true });
    expect(state.elements.find((element) => element.name === "First generation")?.frameId).toBe("F1");
    await page.goto(`data:text/html,<div id=host></div><iframe srcdoc='<button>Light frame</button>'></iframe><script>host.attachShadow({mode:'open'}).innerHTML='<iframe srcdoc="<button>Shadow frame</button>"></iframe>'<\/script>`);
    await page.locator("#host iframe").contentFrame().getByRole("button").waitFor();
    state = await collectPageState(page, { full: true });
    expect(state.elements.find((element) => element.name === "Shadow frame")?.frameId).toBe("F1");
    expect(state.elements.find((element) => element.name === "Light frame")?.frameId).toBe("F2");
  });

  it("bounds frame and record work and reports the generic closed-root capability limitation", async () => {
    await page.setContent(`<div id="closed-shadow-name-only"></div><div id="ordinary"></div>${Array.from({ length: 5_200 }, (_, index) => `<button>Stress ${index}</button>`).join("")}${Array.from({ length: 70 }, () => `<iframe srcdoc='<button>Frame stress</button>'></iframe>`).join("")}`);
    const state = await collectPageState(page, { full: true, maxNodes: 1_000 });
    expect(state.elements.length).toBeLessThanOrEqual(1_000);
    expect(state.truncation.truncated).toBe(true);
    expect(state.warnings[0]).toMatch(/closed shadow roots cannot be inspected/i);
    expect(state.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/candidate scan was truncated/i)]));
  }, 20_000);

  it("selects the same composed-DOM frame prefix from 150 siblings regardless of attachment order", async () => {
    const collectRandomized = async (seed: number) => {
      await page.goto("about:blank");
      await page.evaluate((randomSeed) => {
        const frames = Array.from({ length: 150 }, (_, index) => {
          const frame = document.createElement("iframe");
          frame.dataset.order = String(index).padStart(3, "0");
          frame.srcdoc = `<button>Cap frame ${index}</button>`;
          return frame;
        });
        frames.sort((left, right) => ((Number(left.dataset.order) * 37 + randomSeed) % 71) - ((Number(right.dataset.order) * 37 + randomSeed) % 71));
        document.body.append(...frames);
        const lateLeading = document.createElement("iframe");
        lateLeading.srcdoc = "<button>Late DOM leading</button>";
        document.body.prepend(lateLeading);
        for (const frame of [...frames].sort((left, right) => left.dataset.order!.localeCompare(right.dataset.order!))) document.body.append(frame);
      }, seed);
      await page.locator("iframe").first().contentFrame().getByRole("button").waitFor();
      const state = await collectPageState(page, { full: true, maxNodes: 1_000, breadth: 500 });
      return state.elements.filter((element) => element.name === "Late DOM leading" || element.name.startsWith("Cap frame ")).map((element) => [element.name, element.frameId]);
    };
    const first = await collectRandomized(3);
    const second = await collectRandomized(29);
    expect(second).toEqual(first);
    expect(first).toHaveLength(63);
    expect(first[0]).toEqual(["Late DOM leading", "F1"]);
    expect(first[1]).toEqual(["Cap frame 0", "F2"]);
    expect(first.at(-1)).toEqual(["Cap frame 61", "F63"]);
  }, 30_000);

  it("caps shared descendant text for huge actionable and contenteditable subtrees", async () => {
    await page.setContent('<button id="huge">Huge action</button><div id="editable" contenteditable="true">Huge editor</div>');
    await page.evaluate(() => {
      for (const id of ["huge", "editable"]) {
        const root = document.querySelector(`#${id}`)!;
        for (let index = 0; index < 300; index += 1) {
          const span = document.createElement("span");
          span.textContent = ` nested-${index} `;
          root.append(span);
        }
      }
    });
    const state = await collectPageState(page, { full: true, maxNodes: 1_000, breadth: 500 });
    const action = state.elements.find((element) => element.stableAttributes.id === "huge")!;
    const editable = state.elements.find((element) => element.stableAttributes.id === "editable")!;
    expect(action.name.length).toBeLessThanOrEqual(500);
    expect(editable.value!.length).toBeLessThanOrEqual(500);
    const bounded = await page.evaluate(() => {
      const registry = (window as any).__devBrowserPerceptionState;
      return registry.boundedText(document.querySelector("#huge"), 500, 100);
    });
    expect(bounded).toMatchObject({ truncated: true, visited: 100 });
    expect(bounded.text.length).toBeLessThanOrEqual(500);
  });
});
