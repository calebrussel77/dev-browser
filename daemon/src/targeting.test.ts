import { describe, expect, it } from "vitest";
import type { PerceptionElement } from "./perception/collector.js";
import { findTargets } from "./targeting.js";

function element(ref: string, overrides: Partial<PerceptionElement>): PerceptionElement {
  return {
    ref,
    role: "button",
    name: "Connect",
    description: "",
    landmark: "main",
    semanticAncestors: [],
    box: { x: 10, y: 10, width: 100, height: 30 },
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
    stableAttributes: { id: "", testId: "", href: "" },
    focused: false,
    nearby: { heading: "Profile", label: "", context: "Naminsita Bakayoko" },
    frameId: "F0",
    shadowContext: [],
    depth: 0,
    ...overrides,
  };
}

describe("structured targeting", () => {
  const candidates = [
    element("R2", {
      landmark: "aside",
      nearby: { heading: "Suggestions", label: "", context: "Other people" },
    }),
    element("R1", { landmark: "main.profile-card" }),
    element("R3", {
      name: "Connect now",
      inViewport: false,
      box: { x: 10, y: 900, width: 100, height: 30 },
      disabled: true,
    }),
    element("R4", { name: "Expanded", expanded: true, checked: true, selected: true }),
  ];

  it("distinguishes duplicate names with reasons and reports ambiguous ties", () => {
    const ambiguous = findTargets(
      candidates,
      { role: "button", name: "Connect", nameMode: "exact", scope: "document", states: [] },
      10
    );
    expect(ambiguous.matches.map((match) => match.ref)).toEqual(["R1", "R2"]);
    expect(ambiguous.matches[0]).toMatchObject({
      confidence: "high",
      matchedBecause: ["role=button", "name:exact=Connect"],
    });
    expect(ambiguous.ambiguity).toMatchObject({
      ambiguous: true,
      topScore: expect.any(Number),
      scoreGap: 0,
    });
    const within = findTargets(
      candidates,
      {
        role: "button",
        name: "Connect",
        nameMode: "exact",
        within: "main",
        scope: "document",
        states: [],
      },
      10
    );
    expect(within.matches.map((match) => match.ref)).toEqual(["R1"]);
    expect(within.ambiguity.ambiguous).toBe(false);
  });

  it("supports exact/contains, nearby, scopes, states, frame and explicit index", () => {
    expect(
      findTargets(
        candidates,
        {
          name: "Connect",
          nameMode: "contains",
          near: "Naminsita",
          scope: "visible",
          frame: "F0",
          states: ["enabled"],
        },
        10
      ).matches.map((m) => m.ref)
    ).toEqual(["R1"]);
    expect(
      findTargets(
        candidates,
        { name: "Connect", nameMode: "contains", scope: "viewport", states: [] },
        10
      ).matches.map((m) => m.ref)
    ).toEqual(["R1", "R2"]);
    expect(
      findTargets(
        candidates,
        { name: "Connect", nameMode: "contains", scope: "document", states: ["disabled"] },
        10
      ).matches.map((m) => m.ref)
    ).toEqual(["R3"]);
    expect(
      findTargets(
        candidates,
        { scope: "document", states: ["checked", "expanded", "selected"] },
        10
      ).matches.map((m) => m.ref)
    ).toEqual(["R4"]);
    const indexed = findTargets(
      candidates,
      { name: "Connect", nameMode: "exact", scope: "document", states: [], index: 1 },
      10
    );
    expect(indexed.matches.map((m) => m.ref)).toEqual(["R2"]);
    expect(indexed.ambiguity).toMatchObject({ ambiguous: false, reason: "explicit-index" });
  });

  it("keeps natural query compatibility with deterministic ref ordering", () => {
    const result = findTargets(
      candidates,
      { query: "Connect button", scope: "visible", states: [] },
      10
    );
    expect(result.matches.slice(0, 2).map((match) => match.ref)).toEqual(["R1", "R2"]);
    expect(result.matches[0]!.matchedBecause).toContain("query:Connect button");
  });
});
