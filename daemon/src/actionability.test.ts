import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveActionTarget } from "./actionability.js";

describe("shared actionability pipeline", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  }, 120_000);
  afterAll(async () => browser?.close(), 120_000);

  it("stabilizes boxes, resolves descendants, and reports explicit scrolling", async () => {
    await page.setContent(
      `<div data-dev-browser-ref="R1" role="link" style="margin-top:900px"><button>Connect</button></div>`
    );
    const target = await resolveActionTarget(page, "R1", {
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
      `<button data-dev-browser-ref="R2">Target</button><div id="overlay" role="dialog" aria-label="Blocking dialog" style="position:fixed;inset:0;z-index:9">VERY_SECRET_OVERLAY_TEXT</div>`
    );
    let failure: any;
    try {
      await resolveActionTarget(page, "R2", {
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

  it("rejects hidden, disabled, detached, and unstable targets before input", async () => {
    for (const fixture of [
      `<button data-dev-browser-ref="R3" hidden>Hidden</button>`,
      `<button>Visible ancestor<span data-dev-browser-ref="R3" hidden>Hidden child</span></button>`,
      `<button data-dev-browser-ref="R3" disabled>Disabled</button>`,
    ]) {
      await page.setContent(fixture);
      await expect(
        resolveActionTarget(page, "R3", {
          timeoutMs: 200,
          scroll: false,
          hitTest: false,
          applicability: "pointer",
        })
      ).rejects.toMatchObject({
        code: fixture.includes("hidden") ? "TARGET_HIDDEN" : "TARGET_DISABLED",
      });
    }
    await page.setContent(
      `<button data-dev-browser-ref="R3" style="position:absolute;animation:move .1s linear infinite alternate">Moving</button><style>@keyframes move{from{left:0}to{left:200px}}</style>`
    );
    await expect(
      resolveActionTarget(page, "R3", {
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
    await page.setContent(`<button data-dev-browser-ref="R4">Not a text field</button>`);

    await expect(
      resolveActionTarget(page, "R4", {
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
          ? `<input data-dev-browser-ref="R5" aria-label="Mutable target" style="position:absolute;animation:move .2s linear infinite alternate"><style>@keyframes move{from{left:0}to{left:200px}}</style>`
          : `<input data-dev-browser-ref="R5" aria-label="Mutable target">`
      );
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
        await resolveActionTarget(page, "R5", {
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
