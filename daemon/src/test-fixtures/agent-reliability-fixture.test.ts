import { access } from "node:fs/promises";

import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startAgentReliabilityFixture,
  type AgentReliabilityFixture,
} from "./agent-reliability-fixture.js";

async function expectText(locator: Locator, expected: string): Promise<void> {
  await expect.poll(() => locator.textContent()).toBe(expected);
}

async function expectVisible(locator: Locator): Promise<void> {
  await expect.poll(() => locator.isVisible()).toBe(true);
}

describe("agent reliability fixture", { timeout: 20_000 }, () => {
  let fixture: AgentReliabilityFixture;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    fixture = await startAgentReliabilityFixture();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ acceptDownloads: true });
    await page.goto(fixture.mainUrl);
  }, 20_000);

  afterAll(async () => {
    await browser?.close();
    await fixture?.close();
    await fixture?.close();
  }, 20_000);

  it("provides local URLs, temporary roots, and idempotent cleanup", async () => {
    expect(new URL(fixture.mainUrl).hostname).toBe("127.0.0.1");
    expect(new URL(fixture.crossOriginFrameUrl).hostname).toBe("127.0.0.1");
    expect(new URL(fixture.crossOriginFrameUrl).origin).not.toBe(new URL(fixture.mainUrl).origin);
    await access(fixture.uploadRoot);
    await access(fixture.downloadRoot);

    const disposableFixture = await startAgentReliabilityFixture();
    const disposableUploadRoot = disposableFixture.uploadRoot;
    const disposableDownloadRoot = disposableFixture.downloadRoot;
    await disposableFixture.close();
    await disposableFixture.close();
    await expect(access(disposableUploadRoot)).rejects.toThrow();
    await expect(access(disposableDownloadRoot)).rejects.toThrow();
  });

  it("exposes deterministic controls, overlays, portal UI, and shadow DOM", async () => {
    expect(await page.getByRole("button", { name: "Connect" }).count()).toBe(2);
    await expectVisible(page.locator("main [data-testid=connect-main]"));
    await expectVisible(page.locator("aside [data-testid=connect-aside]"));

    await page.getByTestId("menu-trigger").click();
    await expectVisible(page.getByTestId("portal-menu"));
    await page.getByTestId("dialog-trigger").click();
    await expectVisible(page.getByTestId("fixture-dialog"));
    await page.getByTestId("dialog-close").click();
    await page.getByTestId("toast-trigger").click();
    await expectText(page.getByTestId("fixture-toast"), "Saved locally");

    expect(await page.getByTestId("text-input").isEditable()).toBe(true);
    expect(await page.getByTestId("textarea").isEditable()).toBe(true);
    expect(await page.getByTestId("select").inputValue()).toBe("alpha");
    expect(await page.getByTestId("checkbox").isChecked()).toBe(false);
    expect(await page.getByTestId("radio-a").isChecked()).toBe(true);
    expect(await page.getByTestId("disabled-control").isDisabled()).toBe(true);
    expect(await page.getByTestId("readonly-control").getAttribute("readonly")).toBe("");
    expect(await page.getByTestId("editor").getAttribute("contenteditable")).toBe("true");
    await expectVisible(page.getByTestId("fixed-overlay"));
    expect(
      await page.getByTestId("obscured-target").getAttribute("data-intentionally-obscured")
    ).toBe("true");

    await expectText(page.locator("[data-testid=shadow-host] >> button"), "Shadow action");
    await expectText(
      page.getByTestId("closed-shadow-marker"),
      "Closed shadow root intentionally inaccessible"
    );
    await expectVisible(page.getByTestId("nested-link-button"));
  });

  it("supports delayed updates, requests, SPA and document navigation", async () => {
    await page.getByTestId("delayed-dom-trigger").click();
    await expectText(page.getByTestId("delayed-dom-result"), "DOM updated");

    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/submit") && response.status() === 200
    );
    await page.getByTestId("fetch-trigger").click();
    expect((await responsePromise).request().method()).toBe("POST");
    await expectText(page.getByTestId("fetch-result"), "Fetch complete: accepted");

    const failedRequestPromise = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().endsWith("/api/failure"),
    });
    await page.getByTestId("failed-request-trigger").click();
    await failedRequestPromise;

    await page.getByTestId("spa-navigation").click();
    await expect.poll(() => page.url()).toMatch(/\/spa\/details$/);
    await expectText(page.getByTestId("spa-location"), "/spa/details");

    await page.getByTestId("document-navigation").click();
    await expect.poll(() => page.url()).toMatch(/\/document-target$/);
    await expectText(page.getByTestId("document-target"), "Full document target");
    await page.goto(fixture.mainUrl);
  });

  it("supports scroll, popup, download, upload, and frame lifecycle cases", async () => {
    await page.getByTestId("load-more").click();
    await page.getByTestId("load-more").click();
    await page.getByTestId("load-more").click();
    await expectText(page.getByTestId("load-count"), "3 / 3");
    expect(await page.getByTestId("load-more").isDisabled()).toBe(true);
    await page.getByTestId("scroll-target").scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("popup-link").click();
    const popup = await popupPromise;
    await expectText(popup.getByTestId("popup-target"), "Popup target");
    await popup.close();

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("download-link").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("agent-fixture.txt");
    expect(await download.createReadStream()).not.toBeNull();

    await page.getByTestId("file-input").setInputFiles({
      name: "fixture-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fixture upload"),
    });
    await expectText(page.getByTestId("file-name"), "fixture-upload.txt");

    await expectText(
      page.frameLocator("[data-testid=same-origin-frame]").getByTestId("frame-kind"),
      "same-origin"
    );
    await expectText(
      page.frameLocator("[data-testid=cross-origin-frame]").getByTestId("frame-kind"),
      "cross-origin"
    );
    await expectText(
      page
        .frameLocator("[data-testid=nested-frame]")
        .frameLocator("[data-testid=nested-child-frame]")
        .getByTestId("frame-kind"),
      "nested-child"
    );

    await page.getByTestId("navigate-frame").click();
    await expectText(
      page.frameLocator("[data-testid=navigable-frame]").getByTestId("frame-kind"),
      "navigated"
    );
    await page.getByTestId("remove-frame").click();
    await expect.poll(() => page.getByTestId("navigable-frame").count()).toBe(0);
  });
});
