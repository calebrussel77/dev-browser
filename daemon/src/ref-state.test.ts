import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { AgentProtocolError } from "./agent-protocol.js";
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
});
