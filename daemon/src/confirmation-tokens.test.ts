import { describe, expect, it } from "vitest";
import type { Page } from "playwright";

import { ConfirmationTokenRegistry, type ConfirmationScope } from "./confirmation-tokens.js";

function fakePage() {
  let closed = false;
  let close: (() => void) | undefined;
  return {
    page: { isClosed: () => closed, once: (event: string, listener: () => void) => { if (event === "close") close = listener; } } as unknown as Page,
    close: () => { closed = true; close?.(); },
  };
}

function scope(page: Page): ConfirmationScope {
  return {
    browser: "daily", pageName: "checkout", page, documentId: "doc-7", stateId: "doc-7:9",
    originalRef: "F2:R8", resolvedRef: "F2:R9", targetFingerprint: "fingerprint-a",
    frameId: "F2", framePath: ["F0", "F2"], shadowContext: ["checkout-shell"],
    expectedText: "Naminsita Bakayoko", confirmationText: "Send to Naminsita Bakayoko", url: "https://example.test/send?view=confirm#step",
  };
}

describe("scoped confirmation tokens", () => {
  it("issues opaque tokens, consumes once, and burns concurrent or failed attempts", async () => {
    const target = fakePage();
    const registry = new ConfirmationTokenRegistry(() => 1_000, 5_000);
    const issued = registry.issue(scope(target.page));
    expect(issued.confirmationToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(registry)).not.toContain(issued.confirmationToken);
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => registry.consume(issued.confirmationToken, scope(target.page))),
      Promise.resolve().then(() => registry.consume(issued.confirmationToken, scope(target.page))),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);

    const wrong = registry.issue(scope(target.page));
    expect(() => registry.consume(wrong.confirmationToken, { ...scope(target.page), stateId: "doc-7:10" })).toThrow(/invalid, expired, already used/);
    expect(() => registry.consume(wrong.confirmationToken, scope(target.page))).toThrow(/invalid, expired, already used/);
  });

  it("expires with a fake clock and invalidates every bound scope dimension", () => {
    let now = 1_000;
    const target = fakePage();
    const registry = new ConfirmationTokenRegistry(() => now, 10);
    const expired = registry.issue(scope(target.page));
    now = 1_010;
    expect(() => registry.consume(expired.confirmationToken, scope(target.page))).toThrow(/expired/);

    const mutations: Array<(value: ConfirmationScope) => void> = [
      (value) => { value.browser = "other"; }, (value) => { value.pageName = "other"; },
      (value) => { value.documentId = "doc-8"; }, (value) => { value.stateId = "doc-7:10"; },
      (value) => { value.originalRef = "F2:R10"; }, (value) => { value.resolvedRef = "F2:R10"; },
      (value) => { value.targetFingerprint = "changed"; }, (value) => { value.frameId = "F3"; },
      (value) => { value.framePath = ["F0", "F3"]; }, (value) => { value.shadowContext = ["other-shell"]; },
      (value) => { value.confirmationText = "Send to Someone else"; }, (value) => { value.url = "https://example.test/changed"; },
    ];
    now = 2_000;
    for (const mutate of mutations) {
      const issued = registry.issue(scope(target.page));
      const changed = scope(target.page); mutate(changed);
      expect(() => registry.consume(issued.confirmationToken, changed)).toThrow(/no longer matches/);
    }
    const otherPage = fakePage();
    const issued = registry.issue(scope(target.page));
    expect(() => registry.consume(issued.confirmationToken, scope(otherPage.page))).toThrow(/no longer matches/);
  });

  it("invalidates on page close and registry reset", () => {
    const target = fakePage();
    const registry = new ConfirmationTokenRegistry();
    const closed = registry.issue(scope(target.page));
    target.close();
    expect(() => registry.consume(closed.confirmationToken, scope(target.page))).toThrow(/invalid/);
    const reset = registry.issue(scope(fakePage().page));
    registry.reset();
    expect(() => registry.consume(reset.confirmationToken, scope(fakePage().page))).toThrow(/invalid/);
  });
});
