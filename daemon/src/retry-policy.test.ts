import { describe, expect, it } from "vitest";

import { retryDecision, type AttemptChange } from "./retry-policy.js";
import type { WaitEvents } from "./wait-engine.js";

const events = (): WaitEvents => ({
  requests: [],
  mutations: [],
  focusChanges: [],
  valueChanges: [],
  dialogs: [],
  popup: [],
  download: [],
  fileChooser: [],
  navigation: [],
  responses: [],
  failedRequests: [],
});

const change = (): AttemptChange => ({
  any: false,
  url: false,
  snapshot: false,
  dialog: false,
  ariaExpanded: false,
  dom: false,
  focus: false,
  value: false,
});

describe("side-effect-aware retry policy", () => {
  it("blocks safe retry for every captured browser side effect", () => {
    const cases: Array<[keyof WaitEvents, unknown]> = [
      ["requests", { url: "/api", method: "POST" }],
      ["mutations", { type: "childList", target: "body" }],
      ["focusChanges", { type: "focusin", target: "input#field" }],
      ["valueChanges", { type: "input", target: "input#field" }],
      ["dialogs", { type: "alert", message: "confirm" }],
      ["responses", { url: "/api", method: "POST", status: 200 }],
      ["failedRequests", { url: "/api", method: "POST", failure: "failed" }],
      ["navigation", { url: "/next", document: true }],
      ["popup", { url: "/popup", title: "", opener: "/" }],
      ["download", { url: "/file", suggestedFilename: "file.txt" }],
      ["fileChooser", { multiple: false }],
    ];
    for (const [kind, event] of cases) {
      const sideEffects = events();
      (sideEffects[kind] as unknown[]).push(event);
      const decision = retryDecision({
        policy: "safe",
        attempt: 1,
        guarded: false,
        irreversibleIntent: false,
        sideEffects,
        change: change(),
      });
      expect(decision).toEqual(
        kind === "valueChanges"
          ? { retryDecision: "stop", reason: "value-side-effect" }
          : { retryDecision: "stop", reason: "safe-retry-side-effect-or-change" }
      );
    }
  });

  it("blocks safe retry for DOM, ARIA, focus, value, URL, dialog, and snapshot changes", () => {
    for (const kind of [
      "dom",
      "ariaExpanded",
      "focus",
      "value",
      "url",
      "dialog",
      "snapshot",
    ] as const) {
      const changed = change();
      changed[kind] = true;
      changed.any = true;
      expect(
        retryDecision({
          policy: "safe",
          attempt: 1,
          guarded: false,
          irreversibleIntent: false,
          sideEffects: events(),
          change: changed,
        })
      ).toEqual({ retryDecision: "stop", reason: "safe-retry-side-effect-or-change" });
    }
  });

  it("bounds attempts and blocks guarded or irreversible explicit once retries", () => {
    expect(
      retryDecision({
        policy: "once",
        attempt: 1,
        guarded: true,
        irreversibleIntent: false,
        sideEffects: events(),
        change: change(),
      })
    ).toEqual({ retryDecision: "stop", reason: "guarded-expect-text" });
    expect(
      retryDecision({
        policy: "once",
        attempt: 1,
        guarded: false,
        irreversibleIntent: true,
        sideEffects: events(),
        change: change(),
      })
    ).toEqual({ retryDecision: "stop", reason: "irreversible-intent-blocked" });
    expect(
      retryDecision({
        policy: "safe",
        attempt: 2,
        guarded: false,
        irreversibleIntent: false,
        sideEffects: events(),
        change: change(),
      })
    ).toEqual({ retryDecision: "stop", reason: "retry-limit-reached" });
  });
});
