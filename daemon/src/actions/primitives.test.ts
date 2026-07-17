import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../browser-manager.js";
import { executeInteractiveAction } from "../interactive-actions.js";
import { pageLeases } from "../sessions.js";
import { executePrimitive } from "./primitives.js";

const browser = "primitive-actions";
describe.sequential("trusted interaction primitives", () => {
  let root = "";
  let manager: BrowserManager;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-primitives-"));
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser(browser, { headless: true });
  }, 120_000);
  afterAll(async () => { await manager?.stopAll(); await rm(root, { recursive: true, force: true }); }, 120_000);

  const run = (action: Parameters<typeof executeInteractiveAction>[1]["action"], hooks = {}) =>
    executeInteractiveAction(manager, { id: `primitive-${action.kind}`, type: "interactive", protocolVersion: 2, browser, page: "main", action }, hooks);
  async function ref(name: string) {
    const state = await run({ kind: "read", limit: 100, depth: 12 });
    const element = state.elements!.find((item) => item.name === name);
    if (!element) throw new Error(`Missing ref ${name}`);
    return { ref: element.ref, stateId: state.stateId!, element };
  }

  it("focuses, presses Enter with trusted semantics, and pastes without echoing a secret", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setContent(`<input aria-label="Message"><script>
      window.events=[]; document.querySelector('input').addEventListener('keydown', e => window.events.push([e.key,e.isTrusted]));
    </script>`);
    const target = await ref("Message");
    const focus = await run({ kind: "focus", ref: target.ref, fromState: target.stateId, strictState: true });
    expect(focus.focusedRef).toBe(target.ref);
    const fresh = await ref("Message");
    const press = await run({ kind: "press", ref: fresh.ref, key: "Enter", fromState: fresh.stateId, strictState: true });
    expect(press.pressed).toEqual({ ref: fresh.ref, key: "Enter" });
    expect(await page.evaluate(() => (window as any).events)).toEqual([["Enter", true]]);
    const latest = await ref("Message");
    const secret = "TOP_SECRET_70913";
    const pasted = await run({ kind: "paste", ref: latest.ref, text: secret, fromState: latest.stateId, strictState: true });
    expect(await page.locator("input").inputValue()).toBe(secret);
    expect(JSON.stringify(pasted)).not.toContain(secret);
    expect(pasted.pasted).toEqual({ ref: latest.ref, characters: secret.length, redacted: true });
    expect(pasted.attemptJournal).toHaveLength(2);
    expect(JSON.stringify(pasted.attemptJournal)).not.toContain(secret);
  });

  it("rejects paste artifacts defensively without exposing or persisting plaintext", async () => {
    const secret = "TOP_SECRET_ARTIFACT";
    let failure: unknown;
    try {
      await executeInteractiveAction(manager, { id: "paste-artifact", type: "interactive", protocolVersion: 2, browser, page: "main", shot: "paste-secret.png", action: { kind: "paste", ref: "R1", text: secret } });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "UNSUPPORTED_CONTEXT" });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("retains bounded dispatch journal and wait evidence when a post-paste wait times out", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setContent(`<input aria-label="Timeout field">`);
    const target = await ref("Timeout field");
    const secret = "WAIT_TIMEOUT_SECRET";
    let failure: unknown;
    try {
      await run({
        kind: "paste", ref: target.ref, text: secret, fromState: target.stateId,
        wait: { mode: "all", timeoutMs: 100, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "never appears" }] },
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({
      code: "WAIT_TIMEOUT",
      details: {
        attempts: 2,
        attemptJournal: [
          { inputMethod: "focus", reason: "action-complete" },
          { inputMethod: "keyboard", reason: "action-complete", sideEffects: { valueChanges: expect.any(Array) } },
        ],
      },
    });
    const journal = (failure as any).details.attemptJournal;
    expect(journal[1].sideEffects.valueChanges.length).toBeGreaterThan(0);
    expect(Object.values(journal[1].sideEffects).every((events: any) => events.length <= 2)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("matches scroll-until only on an exact target intersecting both viewport axes", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setViewportSize({ width: 800, height: 400 });
    await page.setContent(`<div style="height:1200px"></div><div id="ancestor"><span style="position:absolute;left:2000px">Needle</span></div>`);
    const result = await run({ kind: "scroll", until: "text:Needle", maxSteps: 2 });
    expect(result.scroll).toMatchObject({ matched: false, steps: 2 });
    expect(result.attemptJournal).toHaveLength(2);

    await page.setContent(`<div role="status" style="position:absolute;left:2000px">offscreen</div>`);
    const role = await run({ kind: "scroll", until: "role:status", maxSteps: 1 });
    expect(role.scroll).toMatchObject({ matched: false, steps: 1 });
  });

  it("scrolls by ref, delta, pages, and bounded until with exact offsets", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setViewportSize({ width: 800, height: 400 });
    await page.setContent(`<div style="height:1200px"></div><button aria-label="Bottom">Bottom</button><div style="height:800px"></div><p>Finished marker</p>`);
    const bottom = await ref("Bottom");
    expect(bottom.element.inViewport).toBe(false);
    expect(bottom.element.actionable).toBe(true);
    const byRef = await run({ kind: "scroll", ref: bottom.ref, fromState: bottom.stateId });
    expect(byRef.scroll!.after.y).toBeGreaterThan(byRef.scroll!.before.y);
    await page.evaluate(() => scrollTo(0, 0));
    const delta = await run({ kind: "scroll", deltaY: 200 });
    expect(delta.scroll!.delta.y).toBe(200);
    const pages = await run({ kind: "scroll", direction: "down", pages: 2 });
    expect(pages.scroll!.delta.y).toBe(800);
    await page.evaluate(() => scrollTo(0, 0));
    const until = await run({ kind: "scroll", until: "text:Finished marker", maxSteps: 5 });
    expect(until.scroll).toMatchObject({ matched: true });
    expect(until.scroll!.steps).toBeGreaterThan(0);
  });

  it("selects and checks with final safe state while rejecting disabled and readonly controls", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setContent(`<select aria-label="Country"><option value="ci">Cote d'Ivoire</option><option value="ng">Nigeria</option></select>
      <input type="checkbox" aria-label="Agree"><input type="checkbox" aria-label="Disabled" disabled><input aria-label="Readonly" readonly>`);
    let target = await ref("Country");
    expect((await run({ kind: "select", ref: target.ref, label: "Nigeria", fromState: target.stateId })).selected)
      .toMatchObject({ value: "ng", label: "Nigeria" });
    target = await ref("Agree");
    expect((await run({ kind: "check", ref: target.ref, fromState: target.stateId })).checked?.checked).toBe(true);
    target = await ref("Agree");
    expect((await run({ kind: "uncheck", ref: target.ref, fromState: target.stateId })).checked?.checked).toBe(false);
    target = await ref("Disabled");
    await expect(run({ kind: "check", ref: target.ref, fromState: target.stateId })).rejects.toMatchObject({ code: "TARGET_DISABLED" });
    target = await ref("Readonly");
    await expect(run({ kind: "paste", ref: target.ref, text: "x", fromState: target.stateId })).rejects.toMatchObject({ code: "TARGET_DISABLED" });
  });

  it("hovers and drags with trusted ordered events, supports waits, and blocks a state race", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setContent(`<button aria-label="Hover me">Hover me</button><div draggable="true" role="button" aria-label="Source">Source</div><div role="button" aria-label="Target">Target</div><script>
      window.events=[]; const record=e=>window.events.push([e.type,e.isTrusted]);
      document.querySelector('button').addEventListener('mouseover', record);
      const source=document.querySelector('[aria-label=Source]'), target=document.querySelector('[aria-label=Target]');
      source.addEventListener('dragstart', record); target.addEventListener('dragover', e=>{e.preventDefault();record(e)}); target.addEventListener('drop', e=>{record(e); target.textContent='Dropped'});
      document.querySelector('button').addEventListener('keydown', e=>{ if(e.key==='Enter'){const p=document.createElement('p');p.textContent='Pressed done';document.body.append(p)} });
    </script>`);
    let target = await ref("Hover me");
    await run({ kind: "hover", ref: target.ref, fromState: target.stateId });
    target = await ref("Hover me");
    const waited = await run({ kind: "press", ref: target.ref, key: "Enter", fromState: target.stateId, wait: { mode: "all", timeoutMs: 2000, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "Pressed done" }] } });
    expect(waited.waitResult?.timedOut).toEqual([]);
    const source = await ref("Source"), destination = await ref("Target");
    const dragged = await run({ kind: "drag", from: source.ref, to: destination.ref, fromState: destination.stateId });
    expect(dragged.dragged?.method).toBe("dragTo");
    expect(await page.locator('[aria-label="Target"]').textContent()).toBe("Dropped");
    expect((await page.evaluate(() => (window as any).events)).every((event: any[]) => event[1])).toBe(true);
    target = await ref("Hover me");
    await expect(run({ kind: "press", ref: target.ref, key: "Space", fromState: target.stateId, strictState: true }, {
      beforeTrustedInput: () => page.locator("button").evaluate((element) => element.setAttribute("aria-label", "Changed")),
    })).rejects.toMatchObject({ code: "STALE_STATE" });
    target = await ref("Changed");
    await expect(run({ kind: "scroll", deltaY: 10, fromState: target.stateId, strictState: true }, {
      beforeTrustedInput: () => page.locator("button").evaluate((element) => element.setAttribute("aria-label", "Changed again")),
    })).rejects.toMatchObject({ code: "STALE_STATE" });
  });

  it("rejects hidden, disabled, and readonly targets before every relevant input", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setContent(`<div style="display:none"><button aria-label="Hidden">Hidden</button></div>
      <button aria-label="Disabled" disabled>Disabled</button><input aria-label="Readonly" readonly>
      <div draggable="true" role="button" aria-label="Disabled source" aria-disabled="true">Source</div>
      <button aria-label="Plain">Plain</button><div role="button" aria-label="Plain source">Source</div>
      <div role="button" aria-label="Drop target">Target</div><script>window.inputs=0;document.addEventListener('keydown',()=>inputs++);document.addEventListener('mouseover',()=>inputs++);document.addEventListener('dragstart',()=>inputs++)</script>`);
    const hidden = await ref("Hidden"), disabled = await ref("Disabled"), readonly = await ref("Readonly");
    const source = await ref("Disabled source"), plain = await ref("Plain"), plainSource = await ref("Plain source"), destination = await ref("Drop target");
    const beforeInputs = await page.evaluate(() => (window as any).inputs);
    await expect(run({ kind: "hover", ref: hidden.ref, fromState: hidden.stateId })).rejects.toMatchObject({ code: "TARGET_HIDDEN" });
    await expect(run({ kind: "hover", ref: disabled.ref, fromState: disabled.stateId })).rejects.toMatchObject({ code: "TARGET_DISABLED" });
    await expect(run({ kind: "press", ref: readonly.ref, key: "Enter", fromState: readonly.stateId })).rejects.toMatchObject({ code: "TARGET_DISABLED" });
    await expect(run({ kind: "drag", from: source.ref, to: destination.ref, fromState: destination.stateId })).rejects.toMatchObject({ code: "TARGET_DISABLED" });
    await expect(run({ kind: "paste", ref: plain.ref, text: "blocked", fromState: plain.stateId })).rejects.toMatchObject({ code: "TARGET_MISSING" });
    await expect(run({ kind: "drag", from: plainSource.ref, to: destination.ref, fromState: destination.stateId })).rejects.toMatchObject({ code: "TARGET_MISSING" });
    expect(await page.evaluate(() => (window as any).inputs)).toBe(beforeInputs);
  });

  it("cleans an already resolved drag source when target resolution fails", async () => {
    let cleaned = 0;
    const page = await manager.getPage(browser, "main");
    await expect(executePrimitive({
      page, timeoutMs: 100, action: { kind: "drag", from: "R1", to: "R2", strictState: false },
      authorize: async () => {},
      resolve: async (requested) => {
        if (requested === "R2") throw new Error("target resolution failed");
        return { locator: page.locator("body"), cleanup: async () => { cleaned += 1; } };
      },
    })).rejects.toThrow("target resolution failed");
    expect(cleaned).toBe(1);
  });

  it("lease races block every primitive family before trusted input", async () => {
    const page = await manager.getPage(browser, "main");
    await page.setContent(`<input aria-label="Field"><select aria-label="Choice"><option>A</option></select><input type="checkbox" aria-label="Box"><button aria-label="Button">Button</button><div draggable="true" role="button" aria-label="Source">Source</div><div role="button" aria-label="Target">Target</div>`);
    const field = await ref("Field"), choice = await ref("Choice"), box = await ref("Box"), button = await ref("Button"), source = await ref("Source"), target = await ref("Target");
    const actions: Parameters<typeof run>[0][] = [
      { kind: "focus", ref: field.ref }, { kind: "press", ref: field.ref, key: "Enter" }, { kind: "paste", ref: field.ref, text: "secret" },
      { kind: "scroll", deltaY: 10 }, { kind: "select", ref: choice.ref, value: "A" }, { kind: "check", ref: box.ref },
      { kind: "hover", ref: button.ref }, { kind: "drag", from: source.ref, to: target.ref },
    ];
    for (const action of actions) {
      let lease: ReturnType<typeof pageLeases.open> | undefined;
      try {
        await expect(run(action, { beforeTrustedInput: () => { lease = pageLeases.open(browser, "main", 300); } }))
          .rejects.toMatchObject({ code: "LEASE_CONFLICT", details: { attemptJournal: expect.any(Array) } });
      } finally { if (lease) pageLeases.close(lease.sessionId); }
    }
    const latest = await ref("Field");
    let calls = 0;
    let lease: ReturnType<typeof pageLeases.open> | undefined;
    try {
      let failure: unknown;
      try {
        await run({ kind: "paste", ref: latest.ref, text: "SECOND_DISPATCH_SECRET", fromState: latest.stateId }, {
          beforeTrustedInput: () => { calls += 1; if (calls === 2) lease = pageLeases.open(browser, "main", 300); },
        });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "LEASE_CONFLICT", details: { attemptJournal: [{ reason: "action-complete" }, { reason: "lease-conflict" }] } });
      expect(JSON.stringify(failure)).not.toContain("SECOND_DISPATCH_SECRET");
      expect(await page.locator('[aria-label="Field"]').inputValue()).toBe("");
    } finally { if (lease) pageLeases.close(lease.sessionId); }
  });
});
