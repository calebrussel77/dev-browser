import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentProtocolError } from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { retryDecision } from "./retry-policy.js";
import {
  startAgentReliabilityFixture,
  type AgentReliabilityFixture,
} from "./test-fixtures/agent-reliability-fixture.js";
import { capturedWaitEvents, runWithWait } from "./wait-engine.js";

describe.sequential("typed event-driven wait engine", () => {
  let root = "";
  let manager: BrowserManager;
  let fixture: AgentReliabilityFixture;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-wait-"));
    fixture = await startAgentReliabilityFixture();
    manager = new BrowserManager(path.join(root, "browsers"));
    await manager.ensureBrowser("wait", { headless: true });
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, root);
    await fixture.close();
  }, 180_000);

  it(
    "composes DOM, URL, ref, surface, changed-value, response, and network-idle conditions",
    { timeout: 30_000 },
    async () => {
      const page = await manager.getPage("wait", "conditions");
      await page.goto(fixture.mainUrl);
      await page
        .locator("[data-testid=text-input]")
        .evaluate((element) => element.setAttribute("data-dev-browser-ref", "R7"));
      const outcome = await runWithWait(
        page,
        { collect: async () => ({ url: page.url() }) },
        {
          mode: "all",
          timeoutMs: 3_000,
          conditions: [
            {
              kind: "text",
              state: "visible",
              scope: "body",
              match: "contains",
              value: "Saved locally",
            },
            { kind: "url", match: "glob", value: "**/spa/details" },
            { kind: "ref", ref: "R7", state: "valueChanged", expected: "done" },
            { kind: "toast", state: "opened" },
            {
              kind: "response",
              match: "contains",
              value: "/api/submit",
              method: "POST",
              status: 200,
            },
            { kind: "networkIdle", specialized: true, idleMs: 25 },
          ],
        },
        async () => {
          await page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>("[data-testid=text-input]")!;
            input.value = "done";
            history.pushState({}, "", "/spa/details");
            document.querySelector<HTMLButtonElement>("[data-testid=toast-trigger]")!.click();
            document.querySelector<HTMLButtonElement>("[data-testid=fetch-trigger]")!.click();
          });
        }
      );
      expect(outcome.waitResult.timedOut).toEqual([]);
      expect(outcome.waitResult.passed).toHaveLength(6);
      expect(outcome.waitResult.events.responses[0]).toMatchObject({ method: "POST", status: 200 });
      expect(outcome.waitResult.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            condition: expect.objectContaining({ kind: "ref", state: "valueChanged" }),
            observed: "done",
            passed: true,
          }),
          expect.objectContaining({
            condition: expect.objectContaining({ kind: "url" }),
            observed: expect.stringContaining("/spa/details"),
            passed: true,
          }),
        ])
      );
      expect(outcome.state).toEqual({ url: expect.stringContaining("/spa/details") });
    }
  );

  it(
    "subscribes before dispatch for synchronous popup, file chooser, navigation, and download events",
    { timeout: 30_000 },
    async () => {
      const page = await manager.getPage("wait", "events");
      await page.goto(fixture.mainUrl);
      for (const [condition, dispatch, eventName] of [
        [
          { kind: "popup" } as const,
          () => page.locator("[data-testid=popup-link]").click(),
          "popup",
        ],
        [
          { kind: "fileChooser" } as const,
          () => page.locator("[data-testid=file-input]").click(),
          "fileChooser",
        ],
        [
          { kind: "navigation", state: "document" } as const,
          () => page.locator("[data-testid=document-navigation]").click(),
          "navigation",
        ],
      ] as const) {
        if (condition.kind !== "navigation") await page.goto(fixture.mainUrl);
        const result = await runWithWait(
          page,
          { collect: async () => null },
          { mode: "all", timeoutMs: 3_000, conditions: [condition] },
          dispatch
        );
        expect(result.waitResult.events[eventName]).not.toHaveLength(0);
        if (condition.kind === "popup") {
          expect(result.waitResult.events.popup[0]).toMatchObject({
            url: expect.stringContaining("/popup-target"),
            title: "Agent reliability fixture",
            opener: expect.stringContaining(fixture.mainUrl),
          });
          await expect(manager.getPage("wait", "events")).resolves.toBe(page);
        }
      }
      await page.goto(fixture.mainUrl);
      const download = await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 3_000,
          conditions: [{ kind: "download" }],
        },
        () => page.locator("[data-testid=download-link]").click()
      );
      expect(download.waitResult.events.download[0]?.suggestedFilename).toBe("agent-fixture.txt");
    }
  );

  it("partitions any-mode timeouts and cleans listeners after success, timeout, and dispatch errors", async () => {
    const page = await manager.getPage("wait", "cleanup");
    await page.setContent("<p>ready</p>");
    const emitter = page as typeof page & { listenerCount(event: string): number };
    const baseline = emitter.listenerCount("response");
    const dialogBaseline = emitter.listenerCount("dialog");
    const expectCaptureCleaned = async () =>
      expect(
        await page.evaluate(
          () =>
            !(
              "__devBrowserWaitCaptureManager" in
              (window as Window & { __devBrowserWaitCaptureManager?: unknown })
            )
        )
      ).toBe(true);
    await page.evaluate(() => {
      (
        window as Window & {
          __testNativeDescriptors?: Array<[object, string, PropertyDescriptor | undefined]>;
        }
      ).__testNativeDescriptors = [
        [
          HTMLInputElement.prototype,
          "value",
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
        ],
        [
          HTMLInputElement.prototype,
          "checked",
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked"),
        ],
        [
          HTMLTextAreaElement.prototype,
          "value",
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
        ],
        [
          HTMLSelectElement.prototype,
          "value",
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value"),
        ],
        [
          HTMLSelectElement.prototype,
          "selectedIndex",
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex"),
        ],
        [
          HTMLOptionElement.prototype,
          "selected",
          Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected"),
        ],
      ];
    });
    const expectNativeDescriptorsRestored = async () =>
      expect(
        await page.evaluate(() => {
          const baselines = (
            window as Window & {
              __testNativeDescriptors?: Array<[object, string, PropertyDescriptor | undefined]>;
            }
          ).__testNativeDescriptors!;
          return baselines.every(([prototype, property, expected]) => {
            const actual = Object.getOwnPropertyDescriptor(prototype, property);
            return (
              actual?.get === expected?.get &&
              actual?.set === expected?.set &&
              actual?.enumerable === expected?.enumerable &&
              actual?.configurable === expected?.configurable
            );
          });
        })
      ).toBe(true);
    const success = await runWithWait(
      page,
      { collect: async () => null },
      {
        mode: "any",
        timeoutMs: 100,
        conditions: [
          { kind: "text", state: "visible", scope: "body", match: "exact", value: "ready" },
          { kind: "popup" },
        ],
      },
      async () => {
        await page.evaluate(() => {
          document.body.setAttribute("data-dev-browser-action-ref", "R-internal");
          document.body.removeAttribute("data-dev-browser-action-ref");
          const overlay = document.createElement("div");
          overlay.setAttribute("data-dev-browser-visual-overlay", "internal");
          document.body.append(overlay);
          overlay.remove();
        });
      }
    );
    expect(success.waitResult.passed).toHaveLength(1);
    expect(success.waitResult.timedOut).toHaveLength(1);
    expect(success.waitResult.events.mutations).toEqual([]);
    expect(emitter.listenerCount("response")).toBe(baseline);
    expect(emitter.listenerCount("dialog")).toBe(dialogBaseline);
    await expectCaptureCleaned();
    await expectNativeDescriptorsRestored();

    let timeout: AgentProtocolError | undefined;
    try {
      await runWithWait(
        page,
        { collect: async () => null },
        { mode: "all", timeoutMs: 20, conditions: [{ kind: "popup" }] },
        async () => {}
      );
    } catch (error) {
      timeout = error as AgentProtocolError;
    }
    expect(timeout).toMatchObject({ code: "WAIT_TIMEOUT", recoverable: true });
    expect(timeout?.details).toMatchObject({ passed: [], timedOut: [expect.any(Object)] });
    expect(emitter.listenerCount("response")).toBe(baseline);
    expect(emitter.listenerCount("dialog")).toBe(dialogBaseline);
    await expectCaptureCleaned();
    await expectNativeDescriptorsRestored();

    await expect(
      runWithWait(
        page,
        { collect: async () => null },
        { mode: "all", timeoutMs: 100, conditions: [{ kind: "popup" }] },
        async () => {
          throw new Error("dispatch failed");
        }
      )
    ).rejects.toThrow("dispatch failed");
    expect(emitter.listenerCount("response")).toBe(baseline);
    expect(emitter.listenerCount("dialog")).toBe(dialogBaseline);
    await expectCaptureCleaned();
    await expectNativeDescriptorsRestored();
  });

  it("multiplexes concurrent waits without draining or cleaning another token", async () => {
    const page = await manager.getPage("wait", "concurrent-capture");
    await page.setContent(`<input id="field">`);
    const originalSetter = await page.evaluateHandle(
      () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set
    );
    let arrivals = 0;
    let releaseBoth!: () => void;
    const bothInstalled = new Promise<void>((resolve) => (releaseBoth = resolve));
    const arrive = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBoth();
      await bothInstalled;
    };
    let firstChanged!: () => void;
    let secondChanged!: () => void;
    const firstDone = new Promise<void>((resolve) => (firstChanged = resolve));
    const secondDone = new Promise<void>((resolve) => (secondChanged = resolve));
    const wait = (dispatch: () => Promise<void>) =>
      runWithWait(
        page,
        { collect: async () => null },
        { mode: "all", timeoutMs: 500, conditions: [{ kind: "popup" }] },
        dispatch
      ).catch((error) => error as AgentProtocolError);

    const first = wait(async () => {
      await arrive();
      await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>("#field")!;
        field.value = "first";
        field.value = "";
      });
      firstChanged();
      await secondDone;
    });
    const second = wait(async () => {
      await arrive();
      await firstDone;
      await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>("#field")!;
        field.value = "second";
        field.value = "";
      });
      secondChanged();
    });
    const [firstError, secondError] = await Promise.all([first, second]);
    for (const error of [firstError, secondError]) {
      expect(error).toMatchObject({ code: "WAIT_TIMEOUT" });
      const sideEffects = capturedWaitEvents(error)!;
      expect(sideEffects.valueChanges).toHaveLength(4);
      expect(
        retryDecision({
          policy: "safe",
          attempt: 1,
          guarded: false,
          irreversibleIntent: false,
          sideEffects,
          change: {
            any: false,
            url: false,
            snapshot: false,
            dialog: false,
            ariaExpanded: false,
            dom: false,
            focus: false,
            value: false,
          },
        })
      ).toEqual({ retryDecision: "stop", reason: "value-side-effect" });
    }
    expect(
      await page.evaluate(
        () =>
          !(
            "__devBrowserWaitCaptureManager" in
            (window as Window & { __devBrowserWaitCaptureManager?: unknown })
          )
      )
    ).toBe(true);
    const restoredSetter = await page.evaluateHandle(
      () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set
    );
    expect(await originalSetter.evaluate((setter, other) => setter === other, restoredSetter)).toBe(
      true
    );
    await originalSetter.dispose();
    await restoredSetter.dispose();
  });

  it("rolls back every installed setter when transactional capture installation fails", async () => {
    const page = await manager.getPage("wait", "capture-rollback");
    await page.setContent(`<input><textarea></textarea>`);
    await page.evaluate(() => {
      const captureWindow = window as Window & {
        __rollbackBaselines?: Record<string, PropertyDescriptor>;
      };
      captureWindow.__rollbackBaselines = {
        inputValue: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!,
        inputChecked: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!,
      };
      const textareaValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!;
      Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
        ...textareaValue,
        configurable: false,
      });
    });
    let dispatched = false;
    await expect(
      runWithWait(
        page,
        { collect: async () => null },
        { mode: "all", timeoutMs: 100, conditions: [{ kind: "popup" }] },
        () => {
          dispatched = true;
        }
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONTEXT" });
    expect(dispatched).toBe(false);
    expect(
      await page.evaluate(() => {
        const captureWindow = window as Window & {
          __rollbackBaselines?: Record<string, PropertyDescriptor>;
          __devBrowserWaitCaptureManager?: unknown;
        };
        const same = (
          actual: PropertyDescriptor | undefined,
          expected: PropertyDescriptor | undefined
        ) =>
          expected !== undefined &&
          actual?.get === expected.get &&
          actual?.set === expected.set &&
          actual?.enumerable === expected.enumerable &&
          actual?.configurable === expected.configurable;
        return (
          same(
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
            captureWindow.__rollbackBaselines!.inputValue
          ) &&
          same(
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked"),
            captureWindow.__rollbackBaselines!.inputChecked
          ) &&
          !("__devBrowserWaitCaptureManager" in captureWindow)
        );
      })
    ).toBe(true);
    await page.close();
  });

  it(
    "evaluates every ref state and dialog/toast opened and closed transitions",
    { timeout: 30_000 },
    async () => {
      const page = await manager.getPage("wait", "state-families");
      const cases = [
        ["attached", "", "document.body.innerHTML='<button data-dev-browser-ref=R1>One</button>'"],
        [
          "detached",
          "<button data-dev-browser-ref=R1>One</button>",
          "document.querySelector('[data-dev-browser-ref=R1]').remove()",
        ],
        [
          "visible",
          "<button hidden data-dev-browser-ref=R1>One</button>",
          "document.querySelector('[data-dev-browser-ref=R1]').hidden=false",
        ],
        [
          "hidden",
          "<button data-dev-browser-ref=R1>One</button>",
          "document.querySelector('[data-dev-browser-ref=R1]').hidden=true",
        ],
        [
          "enabled",
          "<button disabled data-dev-browser-ref=R1>One</button>",
          "document.querySelector('[data-dev-browser-ref=R1]').disabled=false",
        ],
        [
          "disabled",
          "<button data-dev-browser-ref=R1>One</button>",
          "document.querySelector('[data-dev-browser-ref=R1]').disabled=true",
        ],
      ] as const;
      for (const [state, markup, script] of cases) {
        await page.setContent(markup);
        const result = await runWithWait(
          page,
          { collect: async () => null },
          {
            mode: "all",
            timeoutMs: 300,
            conditions: [{ kind: "ref", ref: "R1", state }],
          },
          () => page.evaluate(script)
        );
        expect(result.waitResult.passed[0]).toMatchObject({ kind: "ref", state });
      }
      for (const condition of [
        {
          kind: "ref",
          ref: "R1",
          state: "attributeChanged",
          attribute: "aria-expanded",
          expected: "true",
        } as const,
        {
          kind: "ref",
          ref: "R1",
          state: "stateChanged",
          attribute: "checked",
          expected: "true",
        } as const,
      ]) {
        await page.setContent(
          '<input type="checkbox" data-dev-browser-ref="R1" aria-expanded="false">'
        );
        const result = await runWithWait(
          page,
          { collect: async () => null },
          { mode: "all", timeoutMs: 300, conditions: [condition] },
          () =>
            page.evaluate((state) => {
              const input = document.querySelector<HTMLInputElement>("input")!;
              if (state === "attributeChanged") input.setAttribute("aria-expanded", "true");
              else input.checked = true;
            }, condition.state)
        );
        expect(result.waitResult.timedOut).toEqual([]);
      }

      await page.setContent(
        '<dialog open>Existing</dialog><div role="status">Existing toast</div>'
      );
      const surfaces = await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 300,
          conditions: [
            { kind: "dialog", state: "closed" },
            { kind: "toast", state: "closed" },
            {
              kind: "text",
              state: "hidden",
              scope: "dialog",
              match: "contains",
              value: "Existing",
            },
          ],
        },
        () =>
          page.evaluate(() => {
            document.querySelector("dialog")!.remove();
            document.querySelector('[role="status"]')!.remove();
          })
      );
      expect(surfaces.waitResult.passed).toHaveLength(3);

      await page.setContent("<main>empty</main>");
      const opened = await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "all",
          timeoutMs: 300,
          conditions: [
            { kind: "dialog", state: "opened" },
            { kind: "toast", state: "opened" },
          ],
        },
        () =>
          page.evaluate(() => {
            document.body.insertAdjacentHTML(
              "beforeend",
              '<div role="dialog">Open</div><div role="alert">Toast</div>'
            );
          })
      );
      expect(opened.waitResult.passed).toHaveLength(2);
    }
  );

  it("captures failed requests, repeated waits without listener growth, and page-close errors", async () => {
    const page = await manager.getPage("wait", "failures");
    await page.goto(fixture.mainUrl);
    const failed = await runWithWait(
      page,
      { collect: async () => null },
      {
        mode: "all",
        timeoutMs: 3_000,
        conditions: [
          { kind: "failedRequest", match: "contains", value: "/api/failure", method: "GET" },
        ],
      },
      () => page.locator("[data-testid=failed-request-trigger]").click()
    );
    expect(failed.waitResult.events.failedRequests[0]).toMatchObject({
      method: "GET",
      url: expect.stringContaining("/api/failure"),
    });

    const emitter = page as typeof page & { listenerCount(event: string): number };
    const baseline = emitter.listenerCount("popup");
    for (let index = 0; index < 5; index += 1) {
      await runWithWait(
        page,
        { collect: async () => null },
        {
          mode: "any",
          timeoutMs: 100,
          conditions: [{ kind: "url", match: "contains", value: fixture.mainUrl }],
        },
        async () => {}
      );
    }
    expect(emitter.listenerCount("popup")).toBe(baseline);

    const closing = await manager.getPage("wait", "closing");
    await closing.setContent("<p>closing</p>");
    await expect(
      runWithWait(
        closing,
        { collect: async () => null },
        { mode: "all", timeoutMs: 100, conditions: [{ kind: "popup" }] },
        () => closing.close()
      )
    ).rejects.toMatchObject({ code: "PAGE_CLOSED", recoverable: true });
  });
});
