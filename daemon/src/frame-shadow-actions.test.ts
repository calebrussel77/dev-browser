import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { attemptFrameContext, emptyWaitEvents, originatingAttemptFrameContext, recordAttempt, unchangedAttempt } from "./action-journal.js";
import type { AttemptJournalEntry } from "./retry-policy.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction } from "./interactive-actions.js";
import { startAgentReliabilityFixture, type AgentReliabilityFixture } from "./test-fixtures/agent-reliability-fixture.js";
import { writeDevBrowserTempFile } from "./temp-files.js";

describe.sequential("frame and shadow action flows", () => {
  const browserName = "frame-shadow-actions";
  const pageName = "fixture";
  let root = "";
  let manager: BrowserManager;
  let fixture: AgentReliabilityFixture;

  const action = (action: any, hooks: any = {}) =>
    executeInteractiveAction(manager, { id: `frame-${action.kind}`, type: "interactive", protocolVersion: 2, browser: browserName, page: pageName, action }, hooks);

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-frame-shadow-"));
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
    fixture = await startAgentReliabilityFixture();
    await action({ kind: "navigate", url: fixture.mainUrl });
  }, 180_000);

  afterAll(async () => {
    await fixture?.close();
    await stopBrowserManagerAndRemoveDirectory(manager, root);
  }, 180_000);

  it("finds and executes trusted actions in same-origin, cross-origin, nested frames, and open roots", async () => {
    const observed = await action({ kind: "observe", full: true });
    const ref = (name: string) => {
      const value = observed.elements?.find((element) => element.name === name)?.ref;
      if (!value) throw new Error(`missing ${name}`);
      return value;
    };
    const frameRef = ref("Same frame action");
    const crossInput = ref("Cross frame input");
    const nestedRef = ref("Nested frame action");
    const shadowRef = ref("Shadow action");
    const nestedShadowRef = ref("Nested shadow input");

    expect(frameRef).toMatch(/^F\d+:R\d+$/);
    expect(observed.elements?.find((element) => element.ref === nestedRef)?.framePath).toHaveLength(3);
    await action({ kind: "click", ref: frameRef, method: "locator", fromState: observed.stateId });
    let fresh = await action({ kind: "observe", full: true });
    const typed = await action({ kind: "type", ref: fresh.elements!.find((element) => element.name === "Cross frame input")!.ref, text: "cross-value", clear: true, delayMs: 0, fromState: fresh.stateId });
    expect(typed.attemptJournal?.every((entry: any) => entry.frameContext?.frameId === crossInput.split(":")[0] && Array.isArray(entry.frameContext.shadowContext))).toBe(true);
    fresh = await action({ kind: "observe", full: true });
    await action({ kind: "click", ref: fresh.elements!.find((element) => element.name === "Nested frame action")!.ref, method: "locator", fromState: fresh.stateId });
    fresh = await action({ kind: "observe", full: true });
    const shadowClick = await action({ kind: "click", ref: fresh.elements!.find((element) => element.name === "Shadow action")!.ref, method: "locator", fromState: fresh.stateId });
    expect(shadowClick.attemptJournal?.[0]?.frameContext).toMatchObject({ frameId: "F0", shadowContext: [expect.stringContaining("shadow-host")] });
    fresh = await action({ kind: "observe", full: true });
    await action({ kind: "type", ref: fresh.elements!.find((element) => element.name === "Nested shadow input")!.ref, text: "shadow-value", clear: true, delayMs: 0, fromState: fresh.stateId });

    const page = await manager.getPage(browserName, pageName);
    expect(await page.frameLocator('[data-testid="same-origin-frame"]').getByTestId("frame-result").textContent()).toBe("clicked");
    expect(await page.frameLocator('[data-testid="cross-origin-frame"]').getByLabel("Cross frame input").inputValue()).toBe("cross-value");
    expect(await page.locator('[data-testid="shadow-result"]').textContent()).toBe("clicked");
    expect(await page.getByLabel("Nested shadow input").inputValue()).toBe("shadow-value");
  }, 20_000);

  it("filters by frame and never acts on a frame replacement after the trusted-input hook", async () => {
    const natural = await action({ kind: "find", role: "button", name: "Initial frame action", nameMode: "exact", scope: "document" });
    const frameId = natural.matches![0]!.frameId;
    expect(natural.matches![0]!.matchedBecause).toContain(`frame=${frameId}`);
    const found = await action({ kind: "find", role: "button", name: "Initial frame action", nameMode: "exact", frame: frameId, scope: "document" });
    expect(found.matches).toHaveLength(1);
    const target = found.matches![0]!;
    const page = await manager.getPage(browserName, pageName);
    await expect(action({ kind: "click", ref: target.ref, method: "locator", fromState: found.stateId }, {
      beforeTrustedInput: () => page.getByTestId("navigable-frame").evaluate((frame: HTMLIFrameElement) => { frame.src = "/frame/navigated"; }),
    })).rejects.toMatchObject({ code: expect.stringMatching(/STALE_REF|FRAME_DETACHED/) });
    await page.getByTestId("navigable-frame").contentFrame().getByText("navigated-clicks:0").waitFor();
  });

  it("never acts on a same-looking open-shadow replacement", async () => {
    const observed = await action({ kind: "observe", full: true });
    const target = observed.elements!.find((element) => element.name === "Shadow action")!;
    const page = await manager.getPage(browserName, pageName);
    await expect(action({ kind: "click", ref: target.ref, method: "locator", fromState: observed.stateId }, {
      beforeTrustedInput: () => page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('[data-testid="shadow-host"]')!.shadowRoot!;
        root.innerHTML = '<button data-testid="shadow-action">Shadow action</button><output>shadow-replacement-clicks:0</output>';
        let clicks = 0;
        root.querySelector("button")!.addEventListener("click", () => { root.querySelector("output")!.textContent = `shadow-replacement-clicks:${++clicks}`; });
      }),
    })).rejects.toMatchObject({ code: "STALE_REF" });
    expect(await page.getByText("shadow-replacement-clicks:0").textContent()).toBe("shadow-replacement-clicks:0");
  });

  it("routes the remaining shared primitives, upload, and focused shot through a frame", async () => {
    const expectFrameJournal = (result: any) => {
      expect(result.attemptJournal?.length).toBeGreaterThan(0);
      for (const entry of result.attemptJournal)
        expect(entry.frameContext).toMatchObject({ frameId: expect.stringMatching(/^F\d+$/), framePath: expect.any(Array), shadowContext: expect.any(Array), ref: expect.stringMatching(/^F\d+:R\d+$/) });
    };
    const current = async (name: string) => {
      const observed = await action({ kind: "observe", full: true });
      return { observed, ref: observed.elements!.find((element) => element.name === name)!.ref };
    };
    let target = await current("Frame editor");
    expectFrameJournal(await action({ kind: "focus", ref: target.ref, fromState: target.observed.stateId }));
    target = await current("Frame editor");
    expectFrameJournal(await action({ kind: "paste", ref: target.ref, text: "frame-paste", fromState: target.observed.stateId }));
    target = await current("Frame editor");
    expectFrameJournal(await action({ kind: "press", ref: target.ref, key: "End", fromState: target.observed.stateId }));
    target = await current("Frame editor");
    expectFrameJournal(await action({ kind: "scroll", ref: target.ref, fromState: target.observed.stateId }));
    target = await current("Frame select");
    expectFrameJournal(await action({ kind: "select", ref: target.ref, value: "b", fromState: target.observed.stateId }));
    target = await current("Frame check");
    expectFrameJournal(await action({ kind: "check", ref: target.ref, fromState: target.observed.stateId }));
    target = await current("Frame hover");
    expectFrameJournal(await action({ kind: "hover", ref: target.ref, fromState: target.observed.stateId }));
    const drag = await current("Frame drag source");
    const destination = drag.observed.elements!.find((element) => element.name === "Frame drop target")!;
    expectFrameJournal(await action({ kind: "drag", from: drag.ref, to: destination.ref, fromState: drag.observed.stateId }));
    const controlled = await writeDevBrowserTempFile("uploads/frame-upload.txt", "frame-safe");
    target = await current("Frame upload");
    expectFrameJournal(await action({ kind: "upload", ref: target.ref, file: controlled, fromState: target.observed.stateId }));
    target = await current("Frame editor");
    const shot = await executeInteractiveAction(manager, {
      id: "frame-shot", type: "interactive", protocolVersion: 2, browser: browserName, page: pageName,
      shot: "auto", action: { kind: "shot", ref: target.ref, padding: 12 },
    });
    const page = await manager.getPage(browserName, pageName);
    const same = page.frameLocator('[data-testid="same-origin-frame"]');
    expect(await same.getByLabel("Frame editor").inputValue()).toBe("frame-paste");
    expect(await same.getByLabel("Frame select").inputValue()).toBe("b");
    expect(await same.getByLabel("Frame check").isChecked()).toBe(true);
    expect(await same.getByTestId("frame-events").textContent()).toBe("frame-upload.txt");
    expect(shot.targets?.[0]).toMatchObject({ frameId: expect.stringMatching(/^F\d+$/), method: "screenshot" });
    await rm(shot.screenshotPath!, { force: true });
  }, 30_000);

  it("ignores malicious ref attributes and restores only its owned temporary attribute", async () => {
    const page = await manager.getPage(browserName, pageName);
    await page.setContent(`<button id="actual" data-dev-browser-ref="R999" data-dev-browser-action-ref="site-owned">Safe target</button><button id="redirect" data-dev-browser-ref="R1" data-dev-browser-action-ref="redirect-owned">Redirect</button><output>0:0</output><script>let a=0,r=0;actual.onclick=()=>{a++;document.querySelector('output').textContent=a+':'+r};redirect.onclick=()=>{r++;document.querySelector('output').textContent=a+':'+r}</script>`);
    const observed = await action({ kind: "observe", full: true });
    const target = observed.elements!.find((element) => element.name === "Safe target")!;
    await page.locator("#redirect").evaluate((element, ref) => element.setAttribute("data-dev-browser-ref", ref), target.ref);
    await action({ kind: "click", ref: target.ref, method: "locator", fromState: observed.stateId });
    expect(await page.locator("output").textContent()).toBe("1:0");
    expect(await page.locator("#actual").getAttribute("data-dev-browser-action-ref")).toBe("site-owned");
    expect(await page.locator("#redirect").getAttribute("data-dev-browser-action-ref")).toBe("redirect-owned");
    expect(await page.locator("#redirect").getAttribute("data-dev-browser-ref")).toBe(target.ref);
  });

  it("blocks a partial parent overlay at the projected child point with zero input", async () => {
    const page = await manager.getPage(browserName, pageName);
    await page.setContent(`<style>html,body{margin:0}iframe{position:absolute;left:20px;top:20px;width:280px;height:140px;border:4px solid}.cover{position:absolute;left:48px;top:48px;width:90px;height:42px;z-index:3;background:red}</style><iframe srcdoc='<button style="margin:20px;width:90px;height:42px">Partial target</button><output>clicks:0</output><script>let n=0;document.querySelector("button").onclick=()=>document.querySelector("output").textContent="clicks:"+(++n)<\/script>'></iframe><div class="cover"></div>`);
    await page.locator("iframe").contentFrame().getByRole("button").waitFor();
    const observed = await action({ kind: "observe", full: true });
    const target = observed.elements!.find((element) => element.name === "Partial target")!;
    await expect(action({ kind: "click", ref: target.ref, method: "mouse", fromState: observed.stateId })).rejects.toMatchObject({ code: "TARGET_OBSCURED" });
    expect(await page.locator("iframe").contentFrame().locator("output").textContent()).toBe("clicks:0");
  });

  it("never retries destructive or delayed frame side effects and journals frame context", async () => {
    const page = await manager.getPage(browserName, pageName);
    await page.setContent(`<iframe srcdoc='<button id="destroy">Delete record</button><button id="delayed">Delayed action</button><output>destroy:0 delayed:0</output><script>let d=0,l=0;destroy.onclick=()=>{d++;document.querySelector("output").textContent="destroy:"+d+" delayed:"+l};delayed.onclick=()=>setTimeout(()=>{l++;document.querySelector("output").textContent="destroy:"+d+" delayed:"+l},80)<\/script>'></iframe>`);
    await page.locator("iframe").contentFrame().getByRole("button").first().waitFor();
    let observed = await action({ kind: "observe", full: true });
    let target = observed.elements!.find((element) => element.name === "Delete record")!;
    await expect(action({ kind: "click", ref: target.ref, method: "locator", retry: "once", fromState: observed.stateId, wait: { mode: "all", timeoutMs: 30, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "never" }] } })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { attemptJournal: [expect.objectContaining({ frameContext: expect.objectContaining({ frameId: target.frameId }) })] } });
    expect(await page.locator("iframe").contentFrame().locator("output").textContent()).toContain("destroy:1");
    observed = await action({ kind: "observe", full: true }); target = observed.elements!.find((element) => element.name === "Delayed action")!;
    await expect(action({ kind: "click", ref: target.ref, method: "locator", retry: "safe", fromState: observed.stateId, wait: { mode: "all", timeoutMs: 30, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "never" }] } })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { attemptJournal: [expect.objectContaining({ retryDecision: "stop", frameContext: expect.any(Object) })] } });
    await page.waitForTimeout(120);
    expect(await page.locator("iframe").contentFrame().locator("output").textContent()).toContain("delayed:1");
  }, 20_000);

  it("does not retry when before/after page-signal coverage is truncated", async () => {
    const page = await manager.getPage(browserName, pageName);
    await page.setContent(`<button id="target">Bounded retry</button><output>clicks:0</output><script>let clicks=0;target.onclick=()=>document.querySelector('output').textContent='clicks:'+(++clicks)</script>`);
    const observed = await action({ kind: "observe", full: true });
    const target = observed.elements!.find((element) => element.name === "Bounded retry")!;
    await page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 1_100; index += 1) fragment.append(document.createElement("div"));
      document.body.append(fragment);
    });
    await expect(action({ kind: "click", ref: target.ref, method: "locator", retry: "once", fromState: observed.stateId, wait: { mode: "all", timeoutMs: 30, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "never" }] } })).rejects.toMatchObject({
      code: "WAIT_TIMEOUT",
      details: { attemptJournal: [expect.objectContaining({ retryDecision: "stop", reason: "observation-coverage-truncated", change: expect.objectContaining({ coverageTruncated: true }) })] },
    });
    expect(await page.locator("output").textContent()).toBe("clicks:1");
  });

  it("inherits frame and shadow context for secondary download and popup-failure journal entries", async () => {
    const page = await manager.getPage(browserName, pageName);
    await page.setContent('<iframe></iframe>');
    const inner = page.locator("iframe").contentFrame();
    await inner.locator("body").evaluate((body) => {
      body.innerHTML = '<div id="host"></div>';
      const root = body.querySelector("#host")!.attachShadow({ mode: "open" });
      root.innerHTML = '<a download="frame-shadow.txt" href="data:text/plain,frame-shadow">Shadow download</a><button>Press download</button>';
      root.querySelector("button")!.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") (root.querySelector("a") as HTMLAnchorElement).click(); });
    });
    let observed = await action({ kind: "observe", full: true });
    let target = observed.elements!.find((element) => element.name === "Shadow download")!;
    const clicked = await action({ kind: "click", ref: target.ref, method: "locator", fromState: observed.stateId });
    const clickedContext = clicked.attemptJournal![0]!.frameContext;
    expect(clicked.attemptJournal!.every((entry: AttemptJournalEntry) => JSON.stringify(entry.frameContext) === JSON.stringify(clickedContext))).toBe(true);
    await rm(clicked.download!.path, { force: true });

    observed = await action({ kind: "observe", full: true });
    target = observed.elements!.find((element) => element.name === "Press download")!;
    const pressed = await action({ kind: "press", ref: target.ref, key: "Enter", fromState: observed.stateId });
    const pressedContext = pressed.attemptJournal![0]!.frameContext;
    expect(pressed.attemptJournal!.every((entry: AttemptJournalEntry) => JSON.stringify(entry.frameContext) === JSON.stringify(pressedContext))).toBe(true);
    await rm(pressed.download!.path, { force: true });

    const journal: AttemptJournalEntry[] = [{ attempt: 1, startedAt: new Date().toISOString(), inputMethod: "locator", sideEffects: emptyWaitEvents(), change: unchangedAttempt(), retryDecision: "stop", reason: "action-complete", frameContext: attemptFrameContext(target.ref, { frameId: target.frameId, framePath: target.framePath, shadowContext: target.shadowContext, actualRef: target.ref }) }];
    recordAttempt(journal, { attempt: 2, startedAt: new Date().toISOString(), inputMethod: "popup", sideEffects: emptyWaitEvents(), change: unchangedAttempt(), retryDecision: "stop", reason: "popup-metadata-unavailable" }, originatingAttemptFrameContext(journal));
    expect(journal[1]!.frameContext).toEqual(journal[0]!.frameContext);
  }, 20_000);
});
