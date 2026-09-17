import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import type { PerceptionElement } from "./perception/collector.js";
import { recordPageState } from "./page-state.js";

function element(ref: string, overrides: Partial<PerceptionElement> = {}): PerceptionElement {
  return {
    ref,
    role: "button",
    name: ref,
    description: "",
    landmark: "main",
    semanticAncestors: ["main"],
    box: { x: 0, y: 0, width: 10, height: 10 },
    visible: true,
    inViewport: true,
    actionable: true,
    obscured: false,
    disabled: false,
    readonly: false,
    required: false,
    checked: null,
    selected: null,
    expanded: null,
    pressed: null,
    current: null,
    placeholder: "",
    inputType: "button",
    stableAttributes: { id: ref, testId: "", href: "" },
    focused: false,
    nearby: { heading: "", label: "", context: "" },
    frameId: "F0",
    shadowContext: [],
    depth: 1,
    ...overrides,
  };
}

function snapshot(elements: PerceptionElement[], overrides: Partial<{ url: string; title: string; focusedRef: string | null }> = {}) {
  return {
    url: "https://example.test/before",
    title: "Before",
    focusedRef: null,
    elements,
    ...overrides,
  };
}

describe("page state deltas", () => {
  it("returns a null delta for the first observation on a track", () => {
    const page = {} as Page;
    const first = recordPageState(page, "realm", "default", snapshot([element("R1")]), true);

    expect(first.delta).toBeNull();
  });

  it("keeps track history across document realms for navigation deltas", () => {
    const page = {} as Page;
    recordPageState(page, "realm-before", "default", snapshot([element("R1")]), true);

    const after = recordPageState(
      page,
      "realm-after",
      "default",
      snapshot([element("R2")], { url: "https://example.test/after" }),
      true
    );

    expect(after.delta).toMatchObject({
      url: {
        before: "https://example.test/before",
        after: "https://example.test/after",
      },
      summary: "+1 −1 refs, url changed",
    });
  });

  it("bounds ref lists, summarizes the full change, and reports dialog lifecycle", () => {
    const page = {} as Page;
    const removed = Array.from({ length: 70 }, (_, index) => element(`R${index + 1}`));
    const changedBefore = Array.from({ length: 60 }, (_, index) =>
      element(`R${index + 71}`, { name: `before-${index}` })
    );
    recordPageState(page, "realm", "default", snapshot([...removed, ...changedBefore]), true);

    const changedAfter = Array.from({ length: 60 }, (_, index) =>
      element(`R${index + 71}`, { name: `after-${index}` })
    );
    const added = Array.from({ length: 80 }, (_, index) =>
      element(`R${index + 131}`, index === 0 ? { role: "dialog", name: "Opened" } : {})
    );
    const second = recordPageState(
      page,
      "realm",
      "default",
      snapshot([...changedAfter, ...added], {
        url: "https://example.test/after",
        title: "After",
        focusedRef: "R71",
      }),
      true
    );

    expect(second.delta).toMatchObject({
      added: expect.any(Array),
      removed: expect.any(Array),
      changed: expect.any(Array),
      truncated: true,
      summary: "+80 −70 ~60 refs, url changed, title changed, focus changed, dialog opened",
    });
    expect(second.delta?.added).toHaveLength(50);
    expect(second.delta?.removed).toHaveLength(50);
    expect(second.delta?.changed).toHaveLength(50);

    const third = recordPageState(
      page,
      "realm",
      "default",
      snapshot([...changedAfter, ...added.slice(1)], {
        url: "https://example.test/after",
        title: "After",
        focusedRef: "R71",
      }),
      true
    );
    expect(third.delta?.summary).toBe("−1 refs, dialog closed");
    expect(third.delta?.truncated).toBeUndefined();
  });

  it("computes each semantic fingerprint once per recorded element", () => {
    const page = {} as Page;
    const tracked = element("R1");
    let nameReads = 0;
    Object.defineProperty(tracked, "name", {
      enumerable: true,
      get: () => {
        nameReads += 1;
        return "Tracked";
      },
    });

    recordPageState(page, "realm", "default", snapshot([tracked]), false);

    expect(nameReads).toBe(1);
  });
});
