import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentErrorExitCode, toAgentError } from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction, type InteractiveResult } from "./interactive-actions.js";
import { pageLeases } from "./sessions.js";
import { redactSensitive } from "./redaction.js";
import {
  startAgentReliabilityFixture,
  type AgentReliabilityFixture,
} from "./test-fixtures/agent-reliability-fixture.js";

const browserName = "interactive-actions";

function request(
  action: Parameters<typeof executeInteractiveAction>[1]["action"],
  options: { shot?: string; timeoutMs?: number; annotate?: boolean; fullPage?: boolean } = {}
): Parameters<typeof executeInteractiveAction>[1] {
  return {
    id: `test-${action.kind}`,
    type: "interactive",
    browser: browserName,
    page: "profile",
    action,
    ...options,
  };
}

function elements(result: InteractiveResult) {
  if (!("elements" in result) || !result.elements) {
    throw new Error("Expected interactive elements");
  }
  return result.elements;
}

describe.sequential("interactive Playwright actions", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  let fixture: AgentReliabilityFixture;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-interactive-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
    fixture = await startAgentReliabilityFixture();

    const page = await manager.getPage(browserName, "profile");
    await page.setContent(`
      <main id="profile-main">
        <article class="profile-card">
          <h1>Naminsita Bakayoko</h1>
          <button id="main-connect">Connect</button>
          <button id="open-dynamic">Open dynamic modal</button>
          <button id="retry-button">Retry action</button>
          <button id="changed-button" aria-expanded="false">Changed action</button>
          <a id="wrapped-link" href="#wrapped"><button id="wrapped-button">Wrapped action</button></a>
          <div id="note" role="textbox" contenteditable="true" aria-label="Invitation note"></div>
        </article>
      </main>
      <aside class="people-also-viewed">
        <button id="aside-connect">Connect</button>
      </aside>
      <div role="dialog" aria-label="Invitation confirmation">
        Send an invitation to Naminsita Bakayoko
        <button id="send">Send</button>
      </div>
      <script>
        window.__trustedPointer = false;
        window.__retryClicks = 0;
        window.__changedClicks = 0;
        window.__wrappedTrusted = false;
        document.querySelector('#main-connect').addEventListener('click', event => {
          window.__trustedPointer = event.isTrusted;
        });
        document.querySelector('#open-dynamic').addEventListener('click', () => {
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.textContent = 'Dynamic modal opened';
          document.body.append(dialog);
        });
        document.querySelector('#retry-button').addEventListener('click', () => {
          window.__retryClicks += 1;
          if (window.__retryClicks === 2) {
            const success = document.createElement('p');
            success.textContent = 'Retry success';
            document.body.append(success);
          }
        });
        document.querySelector('#changed-button').addEventListener('click', event => {
          window.__changedClicks += 1;
          event.currentTarget.setAttribute('aria-expanded', 'true');
        });
        document.querySelector('#wrapped-button').addEventListener('click', event => {
          window.__wrappedTrusted = event.isTrusted;
          event.preventDefault();
        });
      </script>
    `);
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, browserRootDir);
    await fixture.close();
  }, 180_000);

  it("returns stable refs, coordinates, visibility, and distinct landmarks", async () => {
    const first = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const second = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );

    const main = elements(first).find(
      (element) => element.name === "Connect" && element.landmark.includes("main")
    );
    const aside = elements(first).find(
      (element) => element.name === "Connect" && element.landmark.includes("aside")
    );

    expect(main).toEqual(
      expect.objectContaining({
        ref: expect.stringMatching(/^R\d+$/),
        role: "button",
        visible: true,
        box: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
      })
    );
    expect(aside).toEqual(
      expect.objectContaining({
        ref: expect.stringMatching(/^R\d+$/),
        role: "button",
        visible: true,
      })
    );
    expect(main!.ref).not.toBe(aside!.ref);
    expect(
      elements(second).find(
        (element) => element.name === "Connect" && element.landmark.includes("main")
      )?.ref
    ).toBe(main!.ref);
    expect("snapshot" in first ? first.snapshot : "").toContain("Naminsita Bakayoko");
  });

  it("uses one v2 state shape for observe and legacy read", async () => {
    const observe = await executeInteractiveAction(manager, {
      ...request({
        kind: "observe",
        full: false,
        delta: false,
        track: "shared",
        maxNodes: 100,
        maxChars: 12_000,
        depth: 12,
        breadth: 50,
      }),
      protocolVersion: 2,
    });
    const read = await executeInteractiveAction(manager, {
      ...request({ kind: "read", limit: 100, depth: 12 }),
      protocolVersion: 2,
    });

    expect(observe.documentId).toBe(read.documentId);
    expect(observe.tree).toBe(read.tree);
    expect(observe.coordinateSpace).toEqual(read.coordinateSpace);
    expect(observe.elements).toEqual(read.elements);
  });

  it("keeps text/assert responses scope bounded instead of re-collecting the full unscoped tree", async () => {
    const text = await executeInteractiveAction(
      manager,
      request({ kind: "text", within: "main", maxChars: 20_000 })
    );
    const assertResult = await executeInteractiveAction(
      manager,
      request({ kind: "assert", within: "main", text: "Naminsita Bakayoko", match: "contains" })
    );

    for (const result of [text, assertResult]) {
      expect(result.coordinateSpace).toBeDefined();
      expect(result.coordinateSpace?.viewport.width).toBeGreaterThan(0);
      expect(result.coordinateSpace?.viewport.height).toBeGreaterThan(0);
      expect(result.tree).toBeUndefined();
      expect(result.elements).toBeUndefined();
    }
    expect(text.textContent).toContain("Naminsita Bakayoko");
    expect(assertResult.asserted).toBe(true);
  });

  it("find ranks the duplicate button in the requested landmark", async () => {
    const result = await executeInteractiveAction(
      manager,
      request({ kind: "find", query: "connect button main profile card", limit: 5 })
    );

    expect(result.matches?.[0]).toEqual(
      expect.objectContaining({
        name: "Connect",
        landmark: expect.stringContaining("main"),
        ref: expect.stringMatching(/^R\d+$/),
      })
    );
  });

  it("find takes a fresh snapshot on every call", async () => {
    await executeInteractiveAction(manager, request({ kind: "read", limit: 100, depth: 12 }));
    const page = await manager.getPage(browserName, "profile");
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Freshly inserted action";
      document.querySelector("main")?.append(button);
    });

    const result = await executeInteractiveAction(
      manager,
      request({ kind: "find", query: "freshly inserted action main", limit: 5 })
    );

    expect(result.matches?.[0]?.name).toBe("Freshly inserted action");
    expect(result.snapshot).toContain("Freshly inserted action");
    expect(result.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Freshly inserted action" })])
    );
  });

  it("returns compact v2 find matches without the full element dump", async () => {
    const result = await executeInteractiveAction(manager, {
      ...request({ kind: "find", query: "connect main", limit: 5 }),
      protocolVersion: 2,
    });

    expect(result.matches?.length).toBeGreaterThan(0);
    expect(result.elements).toBeUndefined();
    expect(result.documentId).toMatch(/^doc-\d+$/);
    expect(result.tree).toEqual(expect.any(String));
  });

  it("returns unified post-action state after acting on a v2 registry ref", async () => {
    const observed = await executeInteractiveAction(manager, {
      ...request({
        kind: "observe",
        full: false,
        delta: false,
        track: "post-action",
        maxNodes: 100,
        maxChars: 12_000,
        depth: 12,
        breadth: 50,
      }),
      protocolVersion: 2,
    });
    const ref = observed.elements?.find((element) => element.name === "Changed action")?.ref;
    const page = await manager.getPage(browserName, "profile");
    try {
      const clicked = await executeInteractiveAction(manager, {
        ...request({ kind: "click", ref: ref!, method: "mouse" }),
        protocolVersion: 2,
      });

      expect(clicked.documentId).toBe(observed.documentId);
      expect(clicked.stateId).not.toBe(observed.stateId);
      expect(clicked.tree).toContain("Changed action");
      expect(clicked.elements).toEqual(expect.any(Array));
    } finally {
      await page.evaluate(() => {
        (window as unknown as { __changedClicks: number }).__changedClicks = 0;
        document.querySelector("#changed-button")?.setAttribute("aria-expanded", "false");
      });
    }
  });

  it("clicks a ref with a trusted mouse event", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const main = elements(read).find(
      (element) => element.name === "Connect" && element.landmark.includes("main")
    );

    await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: main!.ref, method: "mouse" })
    );

    const page = await manager.getPage(browserName, "profile");
    await expect(
      page.evaluate(() => (window as unknown as { __trustedPointer: boolean }).__trustedPointer)
    ).resolves.toBe(true);
  });

  it("returns a refreshed snapshot and reports a dialog change after click", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const opener = elements(read).find((element) => element.name === "Open dynamic modal");

    const result = await executeInteractiveAction(
      manager,
      request({
        kind: "click",
        ref: opener!.ref,
        method: "mouse",
        wait: {
          mode: "all",
          timeoutMs: 1_000,
          conditions: [{ kind: "dialog", state: "opened" }],
        },
      })
    );

    expect(result.change).toEqual(expect.objectContaining({ any: true, dialog: true }));
    expect(result.waitResult).toMatchObject({
      mode: "all",
      timedOut: [],
      passed: [{ kind: "dialog", state: "opened" }],
    });
    expect(result.snapshot).toContain("Dynamic modal opened");
    expect(result.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Dynamic modal opened" })])
    );
    const page = await manager.getPage(browserName, "profile");
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('[role="dialog"]'))
        .find((element) => element.textContent?.includes("Dynamic modal opened"))
        ?.remove();
    });
  });

  it("waits for expected UI and retries one unchanged click", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const retry = elements(read).find((element) => element.name === "Retry action");
    const page = await manager.getPage(browserName, "profile");
    await page.locator("#retry-button").focus();

    const result = await executeInteractiveAction(
      manager,
      request(
        {
          kind: "click",
          ref: retry!.ref,
          method: "mouse",
          waitForText: "Retry success",
        },
        { timeoutMs: 300 }
      )
    );

    expect(result.attempts).toBe(2);
    expect(result.waitSatisfied).toBe(true);
    expect(result.snapshot).toContain("Retry success");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Legacy v1 --wait-for retry compatibility")
    );
  });

  it(
    "never duplicates POST side effects and journals safe, once, and guarded decisions",
    { timeout: 30_000 },
    async () => {
      const page = await manager.getPage(browserName, "profile");
      const initialContent = await page.content();
      await page.goto(fixture.mainUrl);

      const install = async (mode: "post" | "noop") => {
        await page.setContent(`
        <p>Confirmation token</p><button id="action">Action</button><p id="output"></p>
        <script>
          window.inputs = 0;
          action.onclick = () => {
            window.inputs++;
            if (${JSON.stringify(mode)} === "post") {
              fetch("/api/submit", { method: "POST", body: "accepted" });
              setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p>late UI</p>"), 10000);
            } else if (window.inputs === 2) {
              output.textContent = atob("U1VDQ0VTUw==");
            }
          };
        </script>
      `);
        const observed = await executeInteractiveAction(manager, {
          ...request({ kind: "read", limit: 100, depth: 12 }),
          protocolVersion: 2,
        });
        const ref = elements(observed).find((element) => element.name === "Action")!.ref;
        return ref;
      };
      const run = async (
        ref: string,
        retry: "never" | "safe" | "once" | undefined,
        expectText?: string
      ) => {
        let caught: unknown;
        try {
          await executeInteractiveAction(manager, {
            ...request(
              {
                kind: "click",
                ref,
                method: "mouse",
                waitForText: "SUCCESS",
                ...(retry ? { retry } : {}),
                ...(expectText ? { expectText } : {}),
              },
              { timeoutMs: 100 }
            ),
            protocolVersion: 2,
          });
        } catch (error) {
          caught = error;
        }
        return caught as { details: { attemptJournal: Array<Record<string, unknown>> } };
      };

      for (const retry of [undefined, "safe"] as const) {
        let requests = 0;
        const onRequest = (request: { method(): string; url(): string }) => {
          if (request.method() === "POST" && request.url().includes("/api/submit")) requests++;
        };
        page.on("request", onRequest);
        const ref = await install("post");
        const error = await run(ref, retry);
        page.off("request", onRequest);
        expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);
        expect(requests).toBe(1);
        expect(error.details.attemptJournal).toHaveLength(1);
        expect(error.details.attemptJournal[0]).toMatchObject({
          attempt: 1,
          retryDecision: "stop",
          reason: retry === "safe" ? "safe-retry-side-effect-or-change" : "retry-policy-never",
          sideEffects: { requests: [{ method: "POST" }] },
        });
      }

      for (const retry of ["safe", "once"] as const) {
        const ref = await install("noop");
        await page.locator("#action").focus();
        const result = await executeInteractiveAction(manager, {
          ...request(
            { kind: "click", ref, method: "mouse", waitForText: "SUCCESS", retry },
            { timeoutMs: 100 }
          ),
          protocolVersion: 2,
        });
        expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(2);
        expect(result.attemptJournal).toMatchObject([
          {
            attempt: 1,
            retryDecision: "retry",
            reason: retry === "safe" ? "safe-no-side-effect" : "explicit-once",
          },
          { attempt: 2, retryDecision: "stop", reason: "wait-satisfied" },
        ]);
      }

      const guardedRef = await install("noop");
      await page.locator("#action").focus();
      const guarded = await run(guardedRef, "once", "Confirmation token");
      expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);
      expect(guarded.details.attemptJournal[0]).toMatchObject({
        retryDecision: "stop",
        reason: "guarded-expect-text",
      });

      for (const [name, effect, expectedSideEffect, expectedReason] of [
        [
          "transient toast",
          `const toast=document.createElement("div");toast.setAttribute("role","status");document.body.append(toast);toast.remove()`,
          { mutations: expect.any(Array) },
          "safe-retry-side-effect-or-change",
        ],
        [
          "aria toggle back",
          `action.setAttribute("aria-expanded","true");action.setAttribute("aria-expanded","false")`,
          { mutations: expect.any(Array) },
          "safe-retry-side-effect-or-change",
        ],
        [
          "focus revert",
          `field.focus();action.focus()`,
          { focusChanges: expect.any(Array) },
          "safe-retry-side-effect-or-change",
        ],
        [
          "programmatic value revert",
          `field.value="changed";field.value=""`,
          { valueChanges: expect.any(Array) },
          "value-side-effect",
        ],
        [
          "programmatic checked revert",
          `check.checked=true;check.checked=false`,
          { valueChanges: expect.any(Array) },
          "value-side-effect",
        ],
        [
          "programmatic textarea value revert",
          `notes.value="changed";notes.value=""`,
          { valueChanges: expect.any(Array) },
          "value-side-effect",
        ],
        [
          "programmatic select revert",
          `choice.value="b";choice.value="a";choice.selectedIndex=1;choice.selectedIndex=0;optionB.selected=true;optionA.selected=true`,
          { valueChanges: expect.any(Array) },
          "value-side-effect",
        ],
        [
          "native alert",
          `alert("transient native dialog")`,
          { dialogs: expect.any(Array) },
          "safe-retry-side-effect-or-change",
        ],
      ] as const) {
        await page.setContent(`
        <button id="action">Action</button><input id="field"><input id="check" type="checkbox"><textarea id="notes"></textarea>
        <select id="choice"><option id="optionA" value="a">A</option><option id="optionB" value="b">B</option></select>
        <script>window.inputs=0;action.onclick=()=>{window.inputs++;${effect}}</script>
      `);
        const observed = await executeInteractiveAction(manager, {
          ...request({ kind: "read", limit: 100, depth: 12 }),
          protocolVersion: 2,
        });
        const transientRef = elements(observed).find((element) => element.name === "Action")!.ref;
        await page.locator("#action").focus();
        const transientError = await run(transientRef, "safe");
        expect(
          await page.evaluate(() => (window as unknown as { inputs: number }).inputs),
          name
        ).toBe(1);
        expect(transientError.details.attemptJournal).toHaveLength(1);
        expect(transientError.details.attemptJournal[0]).toMatchObject({
          retryDecision: "stop",
          reason: expectedReason,
          sideEffects: expectedSideEffect,
        });
      }

      const stateRef = await install("noop");
      const state = await executeInteractiveAction(manager, {
        ...request({
          kind: "observe",
          full: false,
          delta: false,
          track: "retry-state",
          maxNodes: 100,
          maxChars: 12_000,
          depth: 12,
          breadth: 50,
        }),
        protocolVersion: 2,
      });
      await page.locator("#action").focus();
      let dispatch = 0;
      let stateError: unknown;
      try {
        await executeInteractiveAction(
          manager,
          {
            ...request(
              {
                kind: "click",
                ref: stateRef,
                method: "mouse",
                waitForText: "SUCCESS",
                retry: "safe",
                fromState: state.stateId!,
              },
              { timeoutMs: 100 }
            ),
            protocolVersion: 2,
          },
          {
            beforeTrustedInput: async () => {
              if (++dispatch === 2)
                await page
                  .locator("#action")
                  .evaluate((node) => node.setAttribute("aria-label", "Changed"));
            },
          }
        );
      } catch (error) {
        stateError = error;
      }
      expect(stateError).toMatchObject({
        code: "STALE_REF",
        details: {
          attemptJournal: [
            { attempt: 1, retryDecision: "retry", reason: "safe-no-side-effect" },
            { attempt: 2, retryDecision: "stop", reason: "state-revalidation-failed" },
          ],
        },
      });
      expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);
      await page.setContent(initialContent);
    }
  );

  it("does not retry after aria-expanded changes or for guarded clicks", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const changed = elements(read).find((element) => element.name === "Changed action");

    await expect(
      executeInteractiveAction(
        manager,
        request(
          {
            kind: "click",
            ref: changed!.ref,
            method: "mouse",
            waitForText: "Never appears",
          },
          { timeoutMs: 300 }
        )
      )
    ).rejects.toThrow(/1 attempt/);

    const page = await manager.getPage(browserName, "profile");
    await expect(
      page.evaluate(() => (window as unknown as { __changedClicks: number }).__changedClicks)
    ).resolves.toBe(1);

    await page.evaluate(() => {
      (window as unknown as { __changedClicks: number }).__changedClicks = 0;
      document.querySelector("#changed-button")?.setAttribute("aria-expanded", "false");
    });
    await expect(
      executeInteractiveAction(
        manager,
        request(
          {
            kind: "click",
            ref: changed!.ref,
            method: "mouse",
            expectText: "Naminsita Bakayoko",
            waitForText: "Never appears",
          },
          { timeoutMs: 300 }
        )
      )
    ).rejects.toThrow(/1 attempt/);
    await expect(
      page.evaluate(() => (window as unknown as { __changedClicks: number }).__changedClicks)
    ).resolves.toBe(1);
  });

  it("preserves typed wait timeout status for oversized expected text", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const changed = elements(read).find((element) => element.name === "Changed action");
    const page = await manager.getPage(browserName, "profile");
    await page.evaluate(() => {
      document.querySelector("#changed-button")?.setAttribute("aria-expanded", "false");
    });

    let caught: unknown;
    try {
      await executeInteractiveAction(
        manager,
        request(
          {
            kind: "click",
            ref: changed!.ref,
            method: "mouse",
            waitForText: "Never appears ".repeat(2_000),
          },
          { timeoutMs: 50 }
        )
      );
    } catch (error) {
      caught = error;
    }

    const typed = toAgentError(caught);
    expect(typed.code).toBe("WAIT_TIMEOUT");
    expect(typed.message.length).toBeLessThanOrEqual(4_000);
    expect(agentErrorExitCode(typed.code)).toBe(4);
  });

  it("resolves a link ref to its interactive button descendant", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const link = elements(read).find(
      (element) => element.role === "link" && element.name.includes("Wrapped action")
    );
    const button = elements(read).find(
      (element) => element.role === "button" && element.name === "Wrapped action"
    );

    const result = await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: link!.ref, method: "mouse" })
    );

    expect(result.clicked).toMatchObject({
      ref: button!.ref,
      actualRef: button!.ref,
      originalRef: link!.ref,
      resolvedBy: "descendant",
      method: "mouse",
      actual: { role: "button", name: "Wrapped action", tag: "button" },
      scroll: { scrolled: expect.any(Boolean) },
      box: expect.any(Object),
    });
    expect(result.targets).toEqual([
      expect.objectContaining({
        originalRef: link!.ref,
        actualRef: button!.ref,
        resolvedBy: "descendant",
        method: "mouse",
        actual: { role: "button", name: "Wrapped action", tag: "button" },
        box: expect.any(Object),
        scroll: expect.objectContaining({ scrolled: expect.any(Boolean) }),
      }),
    ]);
    const page = await manager.getPage(browserName, "profile");
    await expect(
      page.evaluate(() => (window as unknown as { __wrappedTrusted: boolean }).__wrappedTrusted)
    ).resolves.toBe(true);
  });

  it("supports trusted locator and coordinate clicks", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const main = elements(read).find(
      (element) => element.name === "Connect" && element.landmark.includes("main")
    );
    const page = await manager.getPage(browserName, "profile");

    await page.evaluate(() => {
      (window as unknown as { __trustedPointer: boolean }).__trustedPointer = false;
    });
    await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: main!.ref, method: "locator" })
    );
    await expect(
      page.evaluate(() => (window as unknown as { __trustedPointer: boolean }).__trustedPointer)
    ).resolves.toBe(true);

    await page.evaluate(() => {
      (window as unknown as { __trustedPointer: boolean }).__trustedPointer = false;
    });
    await executeInteractiveAction(
      manager,
      request({
        kind: "click",
        x: main!.box.x + main!.box.width / 2,
        y: main!.box.y + main!.box.height / 2,
        method: "mouse",
      })
    );
    await expect(
      page.evaluate(() => (window as unknown as { __trustedPointer: boolean }).__trustedPointer)
    ).resolves.toBe(true);
  });

  it("focuses and types into a contenteditable through trusted input", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const note = elements(read).find((element) => element.name === "Invitation note");

    const result = await executeInteractiveAction(
      manager,
      request({ kind: "type", ref: note!.ref, text: "Hello Naminsita", clear: true, delayMs: 0 })
    );

    const page = await manager.getPage(browserName, "profile");
    await expect(page.locator("#note").textContent()).resolves.toBe("Hello Naminsita");
    expect(result.typed).toMatchObject({
      ref: note!.ref,
      actualRef: note!.ref,
      originalRef: note!.ref,
      resolvedBy: "self",
      method: "keyboard",
      box: expect.any(Object),
      scroll: { scrolled: expect.any(Boolean) },
    });
    expect(result.targets).toEqual([
      expect.objectContaining({ actualRef: note!.ref, method: "keyboard" }),
    ]);
    expect(result.inputStrategy).toBe("insert-text");
    expect(result.verifiedValue).toBe("Hello Naminsita");
    // Three revalidated trusted dispatches: mouse focus click, contenteditable
    // select-all+Backspace clear, then insertText.
    expect(result.attemptJournal).toHaveLength(3);
  });

  it("writes a screenshot and returns its absolute path", async () => {
    const shot = `interactive-tests/state-${Date.now()}.png`;
    const result = await executeInteractiveAction(manager, request({ kind: "shot" }, { shot }));
    const screenshotPath = result.screenshotPath;

    expect(path.isAbsolute(screenshotPath ?? "")).toBe(true);
    expect((await stat(screenshotPath!)).size).toBeGreaterThan(0);
    await rm(screenshotPath!, { force: true });
  });

  it("uses CSS pixels for screenshots and click coordinates", async () => {
    const page = await manager.getPage(browserName, "profile");
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const shot = `interactive-tests/css-pixels-${Date.now()}.png`;

    const result = await executeInteractiveAction(manager, request({ kind: "shot" }, { shot }));
    const png = await readFile(result.screenshotPath!);
    const pngWidth = png.readUInt32BE(16);

    expect(result.coordinateSpace).toEqual({
      unit: "css-px",
      screenshotScale: "css",
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
    });
    expect(pngWidth).toBe(800);
    await rm(result.screenshotPath!, { force: true });
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.detach();
  });

  it("returns an annotated artifact for only the matches from find", async () => {
    const shot = `interactive-tests/matches-${Date.now()}.png`;
    const result = await executeInteractiveAction(
      manager,
      request({ kind: "find", query: "Connect", limit: 1 }, { shot, annotate: true })
    );

    expect(result.matches).toHaveLength(1);
    expect(result.artifacts).toMatchObject({
      screenshot: null,
      annotatedScreenshot: {
        path: expect.stringContaining("matches-"),
        mediaType: "image/png",
        mode: "viewport",
        coordinateSpace: { kind: "viewport" },
      },
    });
    expect(result.screenshotPath).toBe(result.artifacts!.annotatedScreenshot!.path);
    await rm(result.screenshotPath!, { force: true });
  });

  it("returns a bounded focused crop for shot by ref", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const link = elements(read).find(
      (element) => element.role === "link" && element.name.includes("Wrapped action")
    )!;
    const button = elements(read).find(
      (element) => element.role === "button" && element.name === "Wrapped action"
    )!;
    const result = await executeInteractiveAction(
      manager,
      request({ kind: "shot", ref: link.ref, padding: 8 }, { shot: "auto" })
    );

    expect(result.artifacts?.screenshot).toMatchObject({
      mode: "crop",
      coordinateSpace: { kind: "viewport" },
    });
    expect(result.artifacts!.screenshot!.width).toBeLessThan(
      result.artifacts!.screenshot!.coordinateSpace.viewport.width
    );
    expect(result.targets).toEqual([
      expect.objectContaining({
        originalRef: link.ref,
        actualRef: button.ref,
        resolvedBy: "descendant",
        method: "screenshot",
        box: expect.any(Object),
        scroll: expect.objectContaining({ scrolled: expect.any(Boolean) }),
      }),
    ]);
    await rm(result.screenshotPath!, { force: true });
  });

  it("reads confirmation text and blocks a mismatched recipient", async () => {
    const confirmed = await executeInteractiveAction(
      manager,
      request({ kind: "confirm", expectText: "Naminsita Bakayoko" })
    );

    expect(confirmed.confirmation?.confirmed).toBe(true);
    expect(confirmed.confirmation).toMatchObject({ expected: "[redacted]", text: "[redacted]" });
    expect(JSON.stringify(confirmed.confirmation)).not.toContain("Naminsita Bakayoko");

    await expect(
      executeInteractiveAction(manager, request({ kind: "confirm", expectText: "Wrong Recipient" }))
    ).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
  });

  it("guards the final click with the current confirmation text", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const send = elements(read).find((element) => element.name === "Send");

    await expect(
      executeInteractiveAction(
        manager,
        request({
          kind: "click",
          ref: send!.ref,
          method: "mouse",
          expectText: "Wrong Recipient",
        })
      )
    ).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
  });

  it("issues a scoped v2 token, consumes it once immediately before input, and rejects hook races", async () => {
    const page = await manager.getPage(browserName, "profile");
    await page.setContent(`<div role="dialog">Send invitation to Naminsita Bakayoko <button id="send">Send</button></div><script>window.sent=0;send.onclick=()=>window.sent++</script>`);
    const observed = await executeInteractiveAction(manager, {
      ...request({ kind: "observe", full: true, delta: false, track: "confirmation", maxNodes: 100, maxChars: 12000, depth: 12, breadth: 50 }),
      protocolVersion: 2,
    });
    const ref = elements(observed).find((element) => element.name === "Send")!.ref;
    const confirmation = await executeInteractiveAction(manager, {
      ...request({ kind: "confirm", ref, expectText: "Naminsita Bakayoko", fromState: observed.stateId }),
      protocolVersion: 2,
    });
    expect(confirmation.confirmationToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(redactSensitive(confirmation, { allowConfirmationToken: true, secrets: ["Naminsita Bakayoko"] }))).not.toContain("Naminsita Bakayoko");
    const guarded = { kind: "click" as const, ref, method: "locator" as const, fromState: confirmation.stateId!, confirmToken: confirmation.confirmationToken! };
    await executeInteractiveAction(manager, { ...request(guarded), protocolVersion: 2 });
    expect(await page.evaluate(() => (window as any).sent)).toBe(1);
    await expect(executeInteractiveAction(manager, { ...request(guarded), protocolVersion: 2 })).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
    expect(await page.evaluate(() => (window as any).sent)).toBe(1);

    const noRetry = await executeInteractiveAction(manager, {
      ...request({ kind: "confirm", ref, expectText: "Naminsita Bakayoko", fromState: confirmation.stateId }),
      protocolVersion: 2,
    });
    await expect(executeInteractiveAction(manager, {
      ...request({
        kind: "click", ref, method: "locator", fromState: noRetry.stateId!, confirmToken: noRetry.confirmationToken!, retry: "once",
        wait: { mode: "all", timeoutMs: 80, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "Never appears" }] },
      }),
      protocolVersion: 2,
    })).rejects.toMatchObject({ code: "WAIT_TIMEOUT", details: { attemptJournal: [expect.objectContaining({ retryDecision: "stop" })] } });
    expect(await page.evaluate(() => (window as any).sent)).toBe(2);

    const fresh = await executeInteractiveAction(manager, {
      ...request({ kind: "confirm", ref, expectText: "Naminsita Bakayoko", fromState: confirmation.stateId }),
      protocolVersion: 2,
    });
    await expect(executeInteractiveAction(manager, {
      ...request({ kind: "click", ref, method: "locator", fromState: fresh.stateId!, confirmToken: fresh.confirmationToken! }),
      protocolVersion: 2,
    }, { beforeTrustedInput: () => page.locator("#send").evaluate((button) => button.replaceWith(button.cloneNode(true))) })).rejects.toMatchObject({ code: "STALE_REF" });
  });

  it("rejects stale v2 decisions before trusted input and allows unrelated attributes", async () => {
    const page = await manager.getPage(browserName, "profile");
    await page.setContent(
      `<button id="target" aria-label="Save">Save</button><p id="noise">one</p><script>window.inputs=0;document.querySelector('#target').onclick=()=>window.inputs++</script>`
    );
    const observe = async () =>
      executeInteractiveAction(manager, {
        ...request({
          kind: "observe",
          full: false,
          delta: false,
          track: "agent-a",
          maxNodes: 100,
          maxChars: 12000,
          depth: 12,
          breadth: 50,
        }),
        protocolVersion: 2,
      });
    const observed = await observe();
    const ref = elements(observed).find((element) => element.name === "Save")!.ref;

    await page.locator("#noise").evaluate((node) => {
      node.textContent = "two";
    });
    await expect(
      executeInteractiveAction(manager, {
        ...request({
          kind: "click",
          ref,
          method: "mouse",
          fromState: observed.stateId!,
          strictState: true,
        }),
        protocolVersion: 2,
      })
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(0);

    const refreshed = await observe();
    await page.locator("#target").evaluate((node) => node.setAttribute("aria-label", "Delete"));
    await expect(
      executeInteractiveAction(manager, {
        ...request({ kind: "click", ref, method: "mouse", fromState: refreshed.stateId! }),
        protocolVersion: 2,
      })
    ).rejects.toMatchObject({ code: "STALE_REF", details: { latest: expect.any(Object) } });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(0);

    const again = await observe();
    const deleteRef = elements(again).find((element) => element.name === "Delete")!.ref;
    await page
      .locator("#noise")
      .evaluate((node) => node.setAttribute("data-animation-counter", "999"));
    await executeInteractiveAction(manager, {
      ...request({ kind: "click", ref: deleteRef, method: "mouse", fromState: again.stateId! }),
      protocolVersion: 2,
    });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);
    const unversioned = await executeInteractiveAction(manager, {
      ...request({ kind: "click", ref: deleteRef, method: "mouse" }),
      protocolVersion: 2,
    });
    expect(unversioned.warnings).toContainEqual(expect.stringContaining("Unversioned decision"));
  });

  it("rejects removal, remount, navigation, and interleaved agent decisions", async () => {
    const page = await manager.getPage(browserName, "profile");
    const observe = async () =>
      executeInteractiveAction(manager, {
        ...request({
          kind: "observe",
          full: false,
          delta: false,
          track: "agents",
          maxNodes: 100,
          maxChars: 12000,
          depth: 12,
          breadth: 50,
        }),
        protocolVersion: 2,
      });
    await page.setContent(
      `<button id="target" aria-expanded="false">Act</button><script>window.inputs=0;document.querySelector('#target').onclick=e=>{window.inputs++;e.currentTarget.setAttribute('aria-expanded','true')}</script>`
    );
    const a = await observe();
    const ref = elements(a).find((element) => element.name === "Act")!.ref;
    await page.locator("#target").evaluate((node) => node.replaceWith(node.cloneNode(true)));
    await expect(
      executeInteractiveAction(manager, {
        ...request({ kind: "click", ref, method: "mouse", fromState: a.stateId! }),
        protocolVersion: 2,
      })
    ).rejects.toMatchObject({ code: "STALE_REF" });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(0);

    const b = await observe();
    const replacementRef = elements(b).find((element) => element.name === "Act")!.ref;
    await page.locator("#target").evaluate((node) => {
      node.addEventListener("click", (event) => {
        (window as unknown as { inputs: number }).inputs++;
        (event.currentTarget as Element).setAttribute("aria-expanded", "true");
      });
    });
    await executeInteractiveAction(manager, {
      ...request({ kind: "click", ref: replacementRef, method: "mouse", fromState: b.stateId! }),
      protocolVersion: 2,
    });
    await expect(
      executeInteractiveAction(manager, {
        ...request({ kind: "click", ref: replacementRef, method: "mouse", fromState: b.stateId! }),
        protocolVersion: 2,
      })
    ).rejects.toMatchObject({ code: "STALE_REF" });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);

    const beforeNavigation = await observe();
    await page.goto(
      "data:text/html,<button id=target>Act</button><script>window.inputs=0;target.onclick=()=>window.inputs++</script>"
    );
    await expect(
      executeInteractiveAction(manager, {
        ...request({
          kind: "click",
          x: 10,
          y: 10,
          method: "mouse",
          fromState: beforeNavigation.stateId!,
        }),
        protocolVersion: 2,
      })
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(0);
  });

  it("enforces writer leases while read-only observation bypasses them", async () => {
    const page = await manager.getPage(browserName, "profile");
    await page.setContent(`<button>Lease target</button>`);
    const lease = pageLeases.open(browserName, "profile", 300);
    try {
      await expect(
        executeInteractiveAction(manager, {
          ...request({ kind: "click", x: 10, y: 10, method: "mouse" }),
          protocolVersion: 2,
        })
      ).rejects.toSatisfy((error: unknown) => {
        const serialized = JSON.stringify(error);
        return (
          (error as { code?: string }).code === "LEASE_CONFLICT" &&
          !serialized.includes(lease.sessionId)
        );
      });
      await expect(
        executeInteractiveAction(manager, {
          ...request({
            kind: "observe",
            full: false,
            delta: false,
            track: "lease",
            maxNodes: 100,
            maxChars: 12000,
            depth: 12,
            breadth: 50,
          }),
          protocolVersion: 2,
        })
      ).resolves.toMatchObject({ action: "observe" });
      await expect(
        executeInteractiveAction(manager, {
          ...request({ kind: "click", x: 10, y: 10, method: "mouse" }),
          protocolVersion: 2,
          session: lease.sessionId,
        })
      ).resolves.toMatchObject({ clicked: expect.any(Object) });
    } finally {
      pageLeases.close(lease.sessionId);
    }
  });

  it("rechecks leases at every trusted dispatch, including between retries", async () => {
    const page = await manager.getPage(browserName, "profile");
    const race = async (action: Parameters<typeof executeInteractiveAction>[1]["action"]) => {
      let lease: ReturnType<typeof pageLeases.open> | undefined;
      try {
        await expect(
          executeInteractiveAction(manager, request(action), {
            beforeTrustedInput: () => {
              lease = pageLeases.open(browserName, "profile", 300);
            },
          })
        ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
      } finally {
        if (lease) pageLeases.close(lease.sessionId);
      }
    };

    await page.setContent(
      `<button id="target">Target</button><input id="field"><script>window.inputs=0;target.onclick=()=>window.inputs++</script>`
    );
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const ref = elements(read).find((element) => element.name === "Target")!.ref;
    await race({ kind: "click", x: 10, y: 10, method: "mouse" });
    await race({ kind: "click", ref, method: "locator" });
    const inputRef = elements(read).find((element) => element.inputType === "text")!.ref;
    await race({ kind: "type", ref: inputRef, text: "blocked", clear: false, delayMs: 0 });
    await race({ kind: "navigate", url: "data:text/html,navigated" });
    expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(0);
    expect(page.url()).not.toContain("navigated");

    const expiring = pageLeases.open(browserName, "profile", 1);
    let replacement: ReturnType<typeof pageLeases.open> | undefined;
    try {
      await expect(
        executeInteractiveAction(
          manager,
          {
            ...request({ kind: "click", x: 10, y: 10, method: "mouse" }),
            session: expiring.sessionId,
          },
          {
            beforeTrustedInput: async () => {
              await new Promise((resolve) => setTimeout(resolve, 1_050));
              replacement = pageLeases.open(browserName, "profile", 300);
            },
          }
        )
      ).rejects.toMatchObject({
        code: "LEASE_CONFLICT",
        details: {
          attemptJournal: [{ attempt: 1, retryDecision: "stop", reason: "lease-conflict" }],
        },
      });
      expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(0);
    } finally {
      if (replacement) pageLeases.close(replacement.sessionId);
    }

    await page.setContent(
      `<button id="retry">Retry</button><script>window.inputs=0;retry.onclick=()=>window.inputs++</script>`
    );
    const retryRead = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const retryRef = elements(retryRead).find((element) => element.name === "Retry")!.ref;
    await page.locator("#retry").focus();
    let dispatch = 0;
    let reacquired: ReturnType<typeof pageLeases.open> | undefined;
    try {
      await expect(
        executeInteractiveAction(
          manager,
          request(
            { kind: "click", ref: retryRef, method: "mouse", waitForText: "never appears" },
            { timeoutMs: 50 }
          ),
          {
            beforeTrustedInput: () => {
              if (++dispatch === 2) reacquired = pageLeases.open(browserName, "profile", 300);
            },
          }
        )
      ).rejects.toMatchObject({
        code: "LEASE_CONFLICT",
        details: {
          attemptJournal: [
            { attempt: 1, retryDecision: "retry", reason: "safe-no-side-effect" },
            { attempt: 2, retryDecision: "stop", reason: "lease-conflict" },
          ],
        },
      });
      expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);
    } finally {
      if (reacquired) pageLeases.close(reacquired.sessionId);
    }
  });

  it("journals trusted-input and page-closed failures", async () => {
    const page = await manager.getPage(browserName, "profile");
    await page.setContent(`
      <button id="covered">Covered</button>
      <div style="position:fixed;inset:0;z-index:999"></div>
    `);
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const coveredRef = elements(read).find((element) => element.name === "Covered")!.ref;
    await expect(
      executeInteractiveAction(
        manager,
        request(
          { kind: "click", ref: coveredRef, method: "locator", retry: "never" },
          { timeoutMs: 100 }
        )
      )
    ).rejects.toMatchObject({
      code: "TARGET_OBSCURED",
      details: {
        obstruction: { tag: "div", box: expect.any(Object) },
        attemptJournal: [{ attempt: 1, retryDecision: "stop", reason: "target-not-actionable" }],
      },
    });

    const closingPage = await manager.getPage(browserName, "journal-page-close");
    await closingPage.setContent(`<button id="close-target">Close target</button>`);
    const closingRead = await executeInteractiveAction(manager, {
      ...request({ kind: "read", limit: 100, depth: 12 }),
      page: "journal-page-close",
    });
    const closeRef = elements(closingRead).find((element) => element.name === "Close target")!.ref;
    await expect(
      executeInteractiveAction(
        manager,
        {
          ...request({ kind: "click", ref: closeRef, method: "mouse", retry: "never" }),
          page: "journal-page-close",
        },
        { beforeTrustedInput: () => closingPage.close() }
      )
    ).rejects.toMatchObject({
      code: "PAGE_CLOSED",
      details: {
        attemptJournal: [{ attempt: 1, retryDecision: "stop", reason: "page-closed" }],
      },
    });
  });

  it("revalidates type after every input hook and blocks replacement before keyboard input", async () => {
    const targetPage = "type-final-validation";
    const page = await manager.getPage(browserName, targetPage);
    await page.setContent(`<input id="field" aria-label="Replaceable field">`);
    const read = await executeInteractiveAction(manager, {
      ...request({ kind: "read", limit: 100, depth: 12 }),
      protocolVersion: 2,
      page: targetPage,
    });
    const field = elements(read).find((element) => element.name === "Replaceable field")!;
    let hooks = 0;
    let failure: unknown;
    try {
      await executeInteractiveAction(
        manager,
        {
          ...request({
            kind: "type",
            ref: field.ref,
            text: "SENSITIVE_REPLACEMENT_TEXT",
            clear: false,
            delayMs: 0,
            fromState: read.stateId,
          }),
          protocolVersion: 2,
          page: targetPage,
        },
        {
          beforeTrustedInput: () => {
            hooks += 1;
            if (hooks === 2) {
              return page.locator("#field").evaluate((element) =>
                element.replaceWith(element.cloneNode(true))
              );
            }
          },
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "STALE_REF",
      details: {
        attemptJournal: [
          { inputMethod: "mouse", reason: "action-complete" },
          { inputMethod: "keyboard", reason: "state-revalidation-failed" },
        ],
      },
    });
    expect(JSON.stringify(failure)).not.toContain("SENSITIVE_REPLACEMENT_TEXT");
    expect(await page.locator("#field").inputValue()).toBe("");
  });

  it("blocks typing when the target center is obstructed", async () => {
    const page = await manager.getPage(browserName, "profile");
    await page.setContent(
      `<input aria-label="Secret field"><div role="dialog" aria-label="Blocking dialog" style="position:fixed;inset:0;z-index:9"></div>`
    );
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const field = elements(read).find((element) => element.name === "Secret field");

    await expect(
      executeInteractiveAction(
        manager,
        request({
          kind: "type",
          ref: field!.ref,
          text: "must-not-type",
          clear: false,
          delayMs: 0,
        })
      )
    ).rejects.toMatchObject({ code: "TARGET_OBSCURED" });
    expect(await page.locator("input").inputValue()).toBe("");
  });
});
