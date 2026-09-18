import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { AgentProtocolError } from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction } from "./interactive-actions.js";
import type { PagePerception } from "./perception/collector.js";
import { validateObservedDecision } from "./ref-state.js";

const latest = {
  documentId: "doc-1",
  stateId: "doc-1:2",
  url: "https://example.test/",
  title: "Fixture",
  coordinateSpace: {
    unit: "css-px",
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 1,
    scroll: { x: 0, y: 0 },
    screenshotScale: "css",
  },
  focusedRef: null,
  tree: "",
  elements: [],
  allElements: [],
  collection: { truncated: false },
  delta: null,
  warnings: [],
  truncation: { truncated: false, omittedNodes: 0, continuation: null },
} satisfies PagePerception;

function staleFor(pageName: string): AgentProtocolError {
  try {
    validateObservedDecision(
      {} as Page,
      pageName,
      { fromState: "expired:1", strictState: true },
      undefined,
      latest,
      null
    );
  } catch (error) {
    if (error instanceof AgentProtocolError) return error;
    throw error;
  }
  throw new Error("expected stale state");
}

describe("state/ref recovery guidance", () => {
  it("emits the unversioned warning only when verbose or strict", () => {
    const page = {} as Page;
    expect(validateObservedDecision(page, "main", {}, undefined, latest, null)).toEqual([]);
    expect(validateObservedDecision(page, "main", {}, undefined, latest, null, true)).toContainEqual(
      expect.stringContaining("Unversioned decision")
    );
    expect(validateObservedDecision(page, "main", { strictState: true }, undefined, latest, null)).toContainEqual(
      expect.stringContaining("Unversioned decision")
    );
  });

  it("quotes and escapes the requested page for PowerShell", () => {
    const error = staleFor("x'; Remove-Item C:\\important\nnext");
    expect(error.code).toBe("STALE_STATE");
    expect(error.nextCommands).toEqual([
      "dev-browser observe --page 'x''; Remove-Item C:\\important next' --delta",
    ]);
  });

  it("bounds recovery commands without replacing the typed stale error", () => {
    const error = staleFor("p".repeat(2_000));
    expect(error.code).toBe("STALE_STATE");
    expect(error.nextCommands).toHaveLength(1);
    expect(error.nextCommands?.[0]?.length).toBeLessThanOrEqual(170);
  });

  it("suggests the rerendered semantic equivalent when a ref becomes stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-stale-candidate-"));
    const manager = new BrowserManager(path.join(root, "browsers"));
    try {
      await manager.ensureBrowser("stale-candidate", { headless: true });
      const page = await manager.getPage("stale-candidate", "main");
      await page.setContent(`<main><button>Continue</button></main>`);
      const observed = await executeInteractiveAction(manager, {
        id: "observe-before-rerender",
        type: "interactive",
        protocolVersion: 2,
        browser: "stale-candidate",
        page: "main",
        elements: true,
        action: { kind: "read", limit: 100, depth: 12 },
      });
      const original = observed.elements!.find((element) => element.name === "Continue")!;
      await page.locator("button").evaluate((button) => button.replaceWith(button.cloneNode(true)));

      let thrown: unknown;
      try {
        await executeInteractiveAction(manager, {
          id: "click-stale-ref",
          type: "interactive",
          protocolVersion: 2,
          browser: "stale-candidate",
          page: "main",
          action: {
            kind: "click",
            ref: original.ref,
            fromState: observed.stateId,
            method: "mouse",
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        code: "STALE_REF",
        details: {
          latest: {
            stateId: expect.any(String),
            url: expect.any(String),
            title: expect.any(String),
          },
          candidates: [
            expect.objectContaining({
              ref: expect.not.stringMatching(new RegExp(`^${original.ref}$`)),
              name: "Continue",
            }),
          ],
        },
        nextCommands: [expect.stringContaining('click --page main --role "button" --name "Continue"')],
      });
    } finally {
      await stopBrowserManagerAndRemoveDirectory(manager, root);
    }
  });
});
