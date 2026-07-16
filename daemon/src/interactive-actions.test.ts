import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { executeInteractiveAction, type InteractiveResult } from "./interactive-actions.js";
import { removeDirectoryWithRetries } from "./test-cleanup.js";

const browserName = "interactive-actions";

function request(
  action: Parameters<typeof executeInteractiveAction>[1]["action"],
  options: { shot?: string; timeoutMs?: number } = {}
): Parameters<typeof executeInteractiveAction>[1] {
  return {
    id: `test-${action.kind}`,
    type: "interactive",
    browser: browserName,
    page: "profile",
    action,
    ...options,
  };
}

function elements(result: InteractiveResult) {
  if (!("elements" in result) || !result.elements) {
    throw new Error("Expected interactive elements");
  }
  return result.elements;
}

describe.sequential("interactive Playwright actions", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-interactive-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });

    const page = await manager.getPage(browserName, "profile");
    await page.setContent(`
      <main id="profile-main">
        <article class="profile-card">
          <h1>Naminsita Bakayoko</h1>
          <button id="main-connect">Connect</button>
          <button id="open-dynamic">Open dynamic modal</button>
          <button id="retry-button">Retry action</button>
          <button id="changed-button" aria-expanded="false">Changed action</button>
          <a id="wrapped-link" href="#wrapped"><button id="wrapped-button">Wrapped action</button></a>
          <div id="note" role="textbox" contenteditable="true" aria-label="Invitation note"></div>
        </article>
      </main>
      <aside class="people-also-viewed">
        <button id="aside-connect">Connect</button>
      </aside>
      <div role="dialog" aria-label="Invitation confirmation">
        Send an invitation to Naminsita Bakayoko
        <button id="send">Send</button>
      </div>
      <script>
        window.__trustedPointer = false;
        window.__retryClicks = 0;
        window.__changedClicks = 0;
        window.__wrappedTrusted = false;
        document.querySelector('#main-connect').addEventListener('click', event => {
          window.__trustedPointer = event.isTrusted;
        });
        document.querySelector('#open-dynamic').addEventListener('click', () => {
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.textContent = 'Dynamic modal opened';
          document.body.append(dialog);
        });
        document.querySelector('#retry-button').addEventListener('click', () => {
          window.__retryClicks += 1;
          if (window.__retryClicks === 2) {
            const success = document.createElement('p');
            success.textContent = 'Retry success';
            document.body.append(success);
          }
        });
        document.querySelector('#changed-button').addEventListener('click', event => {
          window.__changedClicks += 1;
          event.currentTarget.setAttribute('aria-expanded', 'true');
        });
        document.querySelector('#wrapped-button').addEventListener('click', event => {
          window.__wrappedTrusted = event.isTrusted;
          event.preventDefault();
        });
      </script>
    `);
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  it("returns stable refs, coordinates, visibility, and distinct landmarks", async () => {
    const first = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const second = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );

    const main = elements(first).find(
      (element) => element.name === "Connect" && element.landmark.includes("main")
    );
    const aside = elements(first).find(
      (element) => element.name === "Connect" && element.landmark.includes("aside")
    );

    expect(main).toEqual(
      expect.objectContaining({
        ref: expect.stringMatching(/^R\d+$/),
        role: "button",
        visible: true,
        box: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
      })
    );
    expect(aside).toEqual(
      expect.objectContaining({
        ref: expect.stringMatching(/^R\d+$/),
        role: "button",
        visible: true,
      })
    );
    expect(main!.ref).not.toBe(aside!.ref);
    expect(
      elements(second).find(
        (element) => element.name === "Connect" && element.landmark.includes("main")
      )?.ref
    ).toBe(main!.ref);
    expect("snapshot" in first ? first.snapshot : "").toContain("Naminsita Bakayoko");
  });

  it("find ranks the duplicate button in the requested landmark", async () => {
    const result = await executeInteractiveAction(
      manager,
      request({ kind: "find", query: "connect button main profile card", limit: 5 })
    );

    expect(result.matches?.[0]).toEqual(
      expect.objectContaining({
        name: "Connect",
        landmark: expect.stringContaining("main"),
        ref: expect.stringMatching(/^R\d+$/),
      })
    );
  });

  it("find takes a fresh snapshot on every call", async () => {
    await executeInteractiveAction(manager, request({ kind: "read", limit: 100, depth: 12 }));
    const page = await manager.getPage(browserName, "profile");
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Freshly inserted action";
      document.querySelector("main")?.append(button);
    });

    const result = await executeInteractiveAction(
      manager,
      request({ kind: "find", query: "freshly inserted action main", limit: 5 })
    );

    expect(result.matches?.[0]?.name).toBe("Freshly inserted action");
    expect(result.snapshot).toContain("Freshly inserted action");
    expect(result.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Freshly inserted action" })])
    );
  });

  it("clicks a ref with a trusted mouse event", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const main = elements(read).find(
      (element) => element.name === "Connect" && element.landmark.includes("main")
    );

    await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: main!.ref, method: "mouse" })
    );

    const page = await manager.getPage(browserName, "profile");
    await expect(
      page.evaluate(() => (window as unknown as { __trustedPointer: boolean }).__trustedPointer)
    ).resolves.toBe(true);
  });

  it("returns a refreshed snapshot and reports a dialog change after click", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const opener = elements(read).find((element) => element.name === "Open dynamic modal");

    const result = await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: opener!.ref, method: "mouse" })
    );

    expect(result.change).toEqual(expect.objectContaining({ any: true, dialog: true }));
    expect(result.snapshot).toContain("Dynamic modal opened");
    expect(result.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Dynamic modal opened" })])
    );
    const page = await manager.getPage(browserName, "profile");
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('[role="dialog"]'))
        .find((element) => element.textContent?.includes("Dynamic modal opened"))
        ?.remove();
    });
  });

  it("waits for expected UI and retries one unchanged click", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const retry = elements(read).find((element) => element.name === "Retry action");

    const result = await executeInteractiveAction(
      manager,
      request(
        {
          kind: "click",
          ref: retry!.ref,
          method: "mouse",
          waitForText: "Retry success",
        },
        { timeoutMs: 300 }
      )
    );

    expect(result.attempts).toBe(2);
    expect(result.waitSatisfied).toBe(true);
    expect(result.snapshot).toContain("Retry success");
  });

  it("does not retry after aria-expanded changes or for guarded clicks", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const changed = elements(read).find((element) => element.name === "Changed action");

    await expect(
      executeInteractiveAction(
        manager,
        request(
          {
            kind: "click",
            ref: changed!.ref,
            method: "mouse",
            waitForText: "Never appears",
          },
          { timeoutMs: 300 }
        )
      )
    ).rejects.toThrow(/1 attempt/);

    const page = await manager.getPage(browserName, "profile");
    await expect(
      page.evaluate(() => (window as unknown as { __changedClicks: number }).__changedClicks)
    ).resolves.toBe(1);

    await page.evaluate(() => {
      (window as unknown as { __changedClicks: number }).__changedClicks = 0;
      document.querySelector("#changed-button")?.setAttribute("aria-expanded", "false");
    });
    await expect(
      executeInteractiveAction(
        manager,
        request(
          {
            kind: "click",
            ref: changed!.ref,
            method: "mouse",
            expectText: "Naminsita Bakayoko",
            waitForText: "Never appears",
          },
          { timeoutMs: 300 }
        )
      )
    ).rejects.toThrow(/1 attempt/);
    await expect(
      page.evaluate(() => (window as unknown as { __changedClicks: number }).__changedClicks)
    ).resolves.toBe(1);
  });

  it("resolves a link ref to its interactive button descendant", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const link = elements(read).find(
      (element) => element.role === "link" && element.name.includes("Wrapped action")
    );

    const result = await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: link!.ref, method: "mouse" })
    );

    expect(result.clicked?.resolvedBy).toBe("descendant");
    const page = await manager.getPage(browserName, "profile");
    await expect(
      page.evaluate(() => (window as unknown as { __wrappedTrusted: boolean }).__wrappedTrusted)
    ).resolves.toBe(true);
  });

  it("supports trusted locator and coordinate clicks", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const main = elements(read).find(
      (element) => element.name === "Connect" && element.landmark.includes("main")
    );
    const page = await manager.getPage(browserName, "profile");

    await page.evaluate(() => {
      (window as unknown as { __trustedPointer: boolean }).__trustedPointer = false;
    });
    await executeInteractiveAction(
      manager,
      request({ kind: "click", ref: main!.ref, method: "locator" })
    );
    await expect(
      page.evaluate(() => (window as unknown as { __trustedPointer: boolean }).__trustedPointer)
    ).resolves.toBe(true);

    await page.evaluate(() => {
      (window as unknown as { __trustedPointer: boolean }).__trustedPointer = false;
    });
    await executeInteractiveAction(
      manager,
      request({
        kind: "click",
        x: main!.box.x + main!.box.width / 2,
        y: main!.box.y + main!.box.height / 2,
        method: "mouse",
      })
    );
    await expect(
      page.evaluate(() => (window as unknown as { __trustedPointer: boolean }).__trustedPointer)
    ).resolves.toBe(true);
  });

  it("focuses and types into a contenteditable through trusted input", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const note = elements(read).find((element) => element.name === "Invitation note");

    await executeInteractiveAction(
      manager,
      request({ kind: "type", ref: note!.ref, text: "Hello Naminsita", clear: true, delayMs: 0 })
    );

    const page = await manager.getPage(browserName, "profile");
    await expect(page.locator("#note").textContent()).resolves.toBe("Hello Naminsita");
  });

  it("writes a screenshot and returns its absolute path", async () => {
    const shot = `interactive-tests/state-${Date.now()}.png`;
    const result = await executeInteractiveAction(manager, request({ kind: "shot" }, { shot }));
    const screenshotPath = result.screenshotPath;

    expect(path.isAbsolute(screenshotPath ?? "")).toBe(true);
    expect((await stat(screenshotPath!)).size).toBeGreaterThan(0);
    await rm(screenshotPath!, { force: true });
  });

  it("uses CSS pixels for screenshots and click coordinates", async () => {
    const page = await manager.getPage(browserName, "profile");
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const shot = `interactive-tests/css-pixels-${Date.now()}.png`;

    const result = await executeInteractiveAction(manager, request({ kind: "shot" }, { shot }));
    const png = await readFile(result.screenshotPath!);
    const pngWidth = png.readUInt32BE(16);

    expect(result.coordinateSpace).toEqual({
      unit: "css-px",
      screenshotScale: "css",
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
    });
    expect(pngWidth).toBe(800);
    await rm(result.screenshotPath!, { force: true });
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.detach();
  });

  it("reads confirmation text and blocks a mismatched recipient", async () => {
    const confirmed = await executeInteractiveAction(
      manager,
      request({ kind: "confirm", expectText: "Naminsita Bakayoko" })
    );

    expect(confirmed.confirmation?.confirmed).toBe(true);
    expect(confirmed.confirmation?.text).toContain("Naminsita Bakayoko");

    await expect(
      executeInteractiveAction(manager, request({ kind: "confirm", expectText: "Wrong Recipient" }))
    ).rejects.toThrow(/Wrong Recipient/);
  });

  it("guards the final click with the current confirmation text", async () => {
    const read = await executeInteractiveAction(
      manager,
      request({ kind: "read", limit: 100, depth: 12 })
    );
    const send = elements(read).find((element) => element.name === "Send");

    await expect(
      executeInteractiveAction(
        manager,
        request({
          kind: "click",
          ref: send!.ref,
          method: "mouse",
          expectText: "Wrong Recipient",
        })
      )
    ).rejects.toThrow(/Wrong Recipient/);
  });
});
