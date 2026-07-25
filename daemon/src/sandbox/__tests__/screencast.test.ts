import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { DEV_BROWSER_TMP_DIR } from "../../temp-files.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const SANDBOX_TIMEOUT_MS = 90_000;
const browserName = "sandbox-screencast";

/** Matroska/WebM files always open with the EBML magic number. */
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

interface SandboxHarness {
  dispose: () => Promise<void>;
  runJson: <T>(script: string) => Promise<T>;
}

async function createSandbox(manager: BrowserManager): Promise<SandboxHarness> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  await sandbox.initialize();

  return {
    dispose: () => sandbox.dispose(),
    runJson: async <T>(script: string): Promise<T> => {
      stdout.length = 0;
      stderr.length = 0;
      await sandbox.executeScript(`(async () => {\n${script}\n})()`);
      expect(stderr).toEqual([]);
      const lines = stdout.map((line) => line.trim()).filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      return JSON.parse(lines.at(-1)!) as T;
    },
  };
}

describe.sequential("page.screencast inside the QuickJS sandbox", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  let harness: SandboxHarness;

  beforeAll(async () => {
    await ensureSandboxClientBundle();
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-screencast-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
    harness = await createSandbox(manager);
  }, 180_000);

  afterAll(async () => {
    await harness?.dispose();
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  it("records a hero script with chapters and a disposable overlay", async () => {
    const fileName = `sandbox-hero-${Date.now()}.webm`;
    const result = await harness.runJson<{
      overlayOutlivesActions: boolean;
      overlayIsNonInteractive: boolean;
      clickedWhileAnnotated: boolean;
    }>(`
      const page = await browser.newPage();
      await page.setContent(\`
        <button id="target" style="font-size:32px">Click me</button>
        <div id="result"></div>
        <script>
          document.getElementById("target").addEventListener("click", () => {
            document.getElementById("result").textContent = "clicked";
          });
        <\\/script>
      \`);

      await page.screencast.start({ path: ${JSON.stringify(fileName)}, size: { width: 640, height: 480 } });
      await page.screencast.showChapter("Hero script", { description: "Recorded from the sandbox", duration: 800 });

      const annotation = await page.screencast.showOverlay(
        '<div style="position:absolute;top:8px;right:8px;color:white">annotated</div>'
      );

      // The overlay must not intercept input while it is visible.
      await page.click("#target");
      const clickedWhileAnnotated = (await page.textContent("#result")) === "clicked";

      const overlayIsNonInteractive = await page.evaluate(() => {
        const glass = document.querySelector("x-pw-glass");
        return Boolean(glass) && getComputedStyle(glass).pointerEvents === "none";
      });

      await page.waitForTimeout(600);
      const overlayOutlivesActions = await page.evaluate(() => Boolean(document.querySelector("x-pw-glass")));

      await annotation.dispose();
      await page.screencast.hideOverlays();
      await page.screencast.showOverlays();
      await page.screencast.stop();

      console.json({ overlayOutlivesActions, overlayIsNonInteractive, clickedWhileAnnotated });
    `);

    expect(result.clickedWhileAnnotated).toBe(true);
    expect(result.overlayIsNonInteractive).toBe(true);
    expect(result.overlayOutlivesActions).toBe(true);

    // The script names a file; the host decides where it lands.
    const recorded = path.join(DEV_BROWSER_TMP_DIR, "videos", fileName);
    const stats = await stat(recorded);
    expect(stats.size).toBeGreaterThan(0);
    const header = (await readFile(recorded)).subarray(0, EBML_SIGNATURE.length);
    expect(header.equals(EBML_SIGNATURE)).toBe(true);
    await rm(recorded, { force: true });
  }, 180_000);

  it("rejects the onFrame streaming variant with an explicit error", async () => {
    const result = await harness.runJson<{ message: string }>(`
      const page = await browser.newPage();
      await page.setContent("<h1>no frames</h1>");
      let message = "no error";
      try {
        await page.screencast.start({ onFrame: () => {} });
      } catch (error) {
        message = String(error && error.message ? error.message : error);
      }
      console.json({ message });
    `);

    expect(result.message).toContain("onFrame");
    expect(result.message).toContain("not supported");
  }, 180_000);

  it("refuses to escape the controlled video directory", async () => {
    const result = await harness.runJson<{ failed: boolean }>(`
      const page = await browser.newPage();
      await page.setContent("<h1>escape</h1>");
      let failed = false;
      try {
        await page.screencast.start({ path: "C:/escaped.webm" });
      } catch {
        failed = true;
      }
      console.json({ failed });
    `);

    expect(result.failed).toBe(true);
  }, 180_000);
});
