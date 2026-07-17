import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveActionTarget } from "./actionability.js";
import { collectPageState } from "./perception/collector.js";

describe("shared actionability pipeline", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  }, 120_000);
  afterAll(async () => browser?.close(), 120_000);

  const observedRef = async (testId: string) => {
    const state = await collectPageState(page, { full: true });
    const ref = state.elements.find((element) => element.stableAttributes.testId === testId)?.ref;
    if (!ref) throw new Error(`Missing observed ref for ${testId}`);
    return ref;
  };

  it("stabilizes boxes, resolves descendants, and reports explicit scrolling", async () => {
    await page.setContent(
      `<div data-testid="target" role="link" style="margin-top:900px"><button>Connect</button></div>`
    );
    const target = await resolveActionTarget(page, await observedRef("target"), {
      timeoutMs: 1000,
      scroll: true,
      hitTest: true,
      applicability: "pointer",
    });
    try {
      expect(target.resolvedBy).toBe("descendant");
      expect(target.scroll.scrolled).toBe(true);
      expect(target.box.width).toBeGreaterThan(0);
    } finally {
      await target.cleanup();
    }
  });

  it("returns bounded obstruction metadata without overlay text", async () => {
    await page.setContent(
      `<button data-testid="target">Target</button><div id="overlay" role="dialog" aria-label="Blocking dialog" style="position:fixed;inset:0;z-index:9">VERY_SECRET_OVERLAY_TEXT</div>`
    );
    let failure: any;
    try {
      await resolveActionTarget(page, await observedRef("target"), {
        timeoutMs: 500,
        scroll: false,
        hitTest: true,
        applicability: "pointer",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "TARGET_OBSCURED",
      details: {
        obstruction: {
          role: "dialog",
          name: "Blocking dialog",
          tag: "div",
          box: expect.any(Object),
        },
      },
    });
    expect(JSON.stringify(failure)).not.toContain("VERY_SECRET_OVERLAY_TEXT");
  });

  it("uses the requested page in bounded, safely escaped recovery commands", async () => {
    const requestedPage = `profile'; Remove-Item C:\\sensitive\n${"x".repeat(180)}`;
    let failure: any;
    try {
      await resolveActionTarget(page, "R404", {
        timeoutMs: 200,
        scroll: false,
        hitTest: false,
        applicability: "pointer",
        pageName: requestedPage,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure.nextCommands).toHaveLength(1);
    expect(failure.nextCommands[0]).toMatch(
      /^dev-browser observe --page 'profile''; Remove-Item C:\\sensitive x+' --delta$/
    );
    expect(failure.nextCommands[0]).not.toContain("\n");
    expect(failure.nextCommands[0].length).toBeLessThanOrEqual(170);
  });

  it("resolves direct legacy refs only when the v1 compatibility branch is explicit", async () => {
    const descendants = "<span></span>".repeat(650);
    const directName = `Historical direct ${"abcdefghijklmnopqrstuvwxyz".repeat(4)}`;
    const directExpected = directName.slice(0, 80);
    await page.setContent(`<button data-dev-browser-ref="R77">${descendants}  ${directName}  </button>`);
    await collectPageState(page, { full: true });
    await expect(resolveActionTarget(page, "R77", { timeoutMs: 100, scroll: false, hitTest: false, applicability: "pointer" })).rejects.toMatchObject({ code: "TARGET_MISSING" });
    const target = await resolveActionTarget(page, "R77", { timeoutMs: 500, scroll: false, hitTest: true, applicability: "pointer", legacyRefs: true });
    try {
      expect(target.actual.name).toBe(directExpected);
    } finally { await target.cleanup(); }

    const observedName = `Historical observed ${"zyxwvutsrqponmlkjihgfedcba".repeat(4)}`;
    const observedExpected = observedName.slice(0, 80);
    await page.setContent(`<button>${descendants}  ${observedName}  </button>`);
    await collectPageState(page, { full: true });
    const observed = await collectPageState(page, { full: true, legacyRefs: true });
    const observedRef = observed.elements.find((element) => element.role === "button")!.ref;
    const observedTarget = await resolveActionTarget(page, observedRef, { timeoutMs: 500, scroll: false, hitTest: true, applicability: "pointer", legacyRefs: true });
    try {
      expect(observedTarget.actual.name).toBe(observedExpected);
    } finally { await observedTarget.cleanup(); }
  });

  it("rejects hidden, disabled, detached, and unstable targets before input", async () => {
    for (const scenario of [
      {
        markup: `<button data-testid="target">Hidden</button>`,
        mutate: "hidden",
        code: "TARGET_HIDDEN",
      },
      {
        markup: `<button data-testid="target">Disabled</button>`,
        mutate: "disabled",
        code: "TARGET_DISABLED",
      },
    ]) {
      await page.setContent(scenario.markup);
      const ref = await observedRef("target");
      await page.locator("[data-testid=target]").evaluate((element, mutation) => {
        if (mutation === "hidden") (element as HTMLElement).hidden = true;
        else (element as HTMLButtonElement).disabled = true;
      }, scenario.mutate);
      await expect(
        resolveActionTarget(page, ref, {
          timeoutMs: 200,
          scroll: false,
          hitTest: false,
          applicability: "pointer",
        })
      ).rejects.toMatchObject({
        code: scenario.code,
      });
    }
    await page.setContent(
      `<button data-testid="target" style="position:absolute;animation:move .1s linear infinite alternate">Moving</button><style>@keyframes move{from{left:0}to{left:200px}}</style>`
    );
    const movingRef = await observedRef("target");
    await expect(
      resolveActionTarget(page, movingRef, {
        timeoutMs: 180,
        scroll: false,
        hitTest: false,
        applicability: "pointer",
      })
    ).rejects.toMatchObject({ code: "TARGET_MISSING" });
    await page.setContent(`<button>Detached</button>`);
    await expect(
      resolveActionTarget(page, "R99", {
        timeoutMs: 100,
        scroll: false,
        hitTest: false,
        applicability: "pointer",
      })
    ).rejects.toMatchObject({ code: "TARGET_MISSING" });
  });

  it("rejects typing into a visible non-writable target", async () => {
    await page.setContent(`<button data-testid="target">Not a text field</button>`);

    await expect(
      resolveActionTarget(page, await observedRef("target"), {
        timeoutMs: 500,
        scroll: true,
        hitTest: false,
        applicability: "type",
      })
    ).rejects.toMatchObject({ code: "TARGET_MISSING" });
  });

  it("revalidates state and identity after stability sampling", async () => {
    for (const scenario of ["disabled", "readonly", "hidden", "replacement"] as const) {
      await page.setContent(
        scenario === "replacement"
          ? `<input data-testid="target" aria-label="Mutable target" style="position:absolute;animation:move .2s linear infinite alternate"><style>@keyframes move{from{left:0}to{left:200px}}</style>`
          : `<input data-testid="target" aria-label="Mutable target">`
      );
      const ref = await observedRef("target");
      await page.evaluate((nextScenario) => {
        const input = document.querySelector("input")!;
        window.setTimeout(() => {
          if (nextScenario === "disabled") (input as HTMLInputElement).disabled = true;
          if (nextScenario === "readonly") (input as HTMLInputElement).readOnly = true;
          if (nextScenario === "hidden") (input as HTMLElement).style.display = "none";
          if (nextScenario === "replacement") input.replaceWith(input.cloneNode(true));
        }, nextScenario === "replacement" ? 80 : 1);
      }, scenario);

      let failure: unknown;
      try {
        await resolveActionTarget(page, ref, {
          timeoutMs: 500,
          scroll: false,
          hitTest: true,
          applicability: "type",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure, scenario).toMatchObject({
        code:
          scenario === "disabled" || scenario === "readonly"
            ? "TARGET_DISABLED"
            : scenario === "hidden"
              ? "TARGET_HIDDEN"
              : "TARGET_MISSING",
      });
    }
  });
});
