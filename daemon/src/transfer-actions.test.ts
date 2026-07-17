import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { executeInteractiveAction } from "./interactive-actions.js";
import { startAgentReliabilityFixture, type AgentReliabilityFixture } from "./test-fixtures/agent-reliability-fixture.js";
import { DEV_BROWSER_TMP_DIR, reserveUniqueDownloadFile, writeDevBrowserTempFile } from "./temp-files.js";
import { observeRecoveryCommand } from "./recovery-command.js";
import { pageLeases } from "./sessions.js";

describe.sequential("first-class transfer and navigation actions", () => {
  let fixture: AgentReliabilityFixture;
  let manager: BrowserManager;
  let browserRoot: string;
  const browser = "transfer-actions";

  beforeAll(async () => {
    fixture = await startAgentReliabilityFixture();
    browserRoot = await mkdtemp(path.join(os.tmpdir(), "dev-browser-transfer-"));
    manager = new BrowserManager(path.join(browserRoot, "browsers"));
    await manager.ensureBrowser(browser, { headless: true });
  });

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, browserRoot);
    await fixture?.close();
  });

  async function action(page: string, value: Record<string, unknown>) {
    return executeInteractiveAction(manager, {
      id: `${page}-${String(value.kind)}`,
      type: "interactive",
      protocolVersion: 2,
      browser,
      page,
      timeoutMs: 5_000,
      action: value as never,
    });
  }

  async function refNamed(page: string, name: string): Promise<string> {
    const observed = await action(page, { kind: "observe", full: true, maxNodes: 500 });
    const ref = observed.elements?.find((element) => element.name === name)?.ref;
    if (!ref) throw new Error(`No ref named ${name}`);
    return ref;
  }

  it("navigates back, forward, and reloads with explicit before/after identity", async () => {
    await action("history", { kind: "navigate", url: fixture.mainUrl });
    await action("history", { kind: "navigate", url: new URL("/document-target", fixture.mainUrl).toString() });

    const back = await action("history", { kind: "back" });
    expect(back.navigation).toMatchObject({ operation: "back", beforeUrl: expect.stringContaining("/document-target"), afterUrl: fixture.mainUrl });
    expect(back.navigation?.beforeDocumentId).not.toBe(back.navigation?.afterDocumentId);

    const forward = await action("history", { kind: "forward" });
    expect(forward.navigation).toMatchObject({ operation: "forward", afterUrl: expect.stringContaining("/document-target") });

    const reload = await action("history", { kind: "reload" });
    expect(reload.navigation).toMatchObject({ operation: "reload", afterUrl: expect.stringContaining("/document-target") });
    expect(reload.navigation?.beforeDocumentId).not.toBe(reload.navigation?.afterDocumentId);
    expect(reload.navigation?.nextCommand).toBe(observeRecoveryCommand("history"));
  });

  it("reports a recoverable result when history has no previous entry", async () => {
    const result = await action("no-history", { kind: "back" });
    expect(result.navigation).toMatchObject({ operation: "back", navigated: false });
  });

  it("accepts valid strict state guards for back, forward, and reload", async () => {
    await action("strict-history", { kind: "navigate", url: fixture.mainUrl });
    await action("strict-history", { kind: "navigate", url: new URL("/document-target", fixture.mainUrl).toString() });
    let observed = await action("strict-history", { kind: "observe", full: true });
    const back = await action("strict-history", { kind: "back", fromState: observed.stateId, strictState: true });
    expect(back.navigation?.navigated).toBe(true);
    observed = await action("strict-history", { kind: "observe", full: true });
    const forward = await action("strict-history", { kind: "forward", fromState: observed.stateId, strictState: true });
    expect(forward.navigation?.navigated).toBe(true);
    observed = await action("strict-history", { kind: "observe", full: true });
    const reload = await action("strict-history", { kind: "reload", fromState: observed.stateId, strictState: true });
    expect(reload.navigation?.navigated).toBe(true);
  });

  it("detects SPA history from state and URL rather than a navigation response", async () => {
    await action("spa-history", { kind: "navigate", url: fixture.mainUrl });
    const page = await manager.getPage(browser, "spa-history");
    await page.getByTestId("spa-navigation").click();
    const back = await action("spa-history", { kind: "back" });
    expect(back.navigation).toMatchObject({ navigated: true, beforeUrl: expect.stringContaining("/spa/details"), afterUrl: fixture.mainUrl });
  });

  it("rejects a stale navigation decision before changing history", async () => {
    await action("stale-history", { kind: "navigate", url: fixture.mainUrl });
    await action("stale-history", { kind: "navigate", url: new URL("/document-target", fixture.mainUrl).toString() });
    const observed = await action("stale-history", { kind: "observe", full: true });
    await (await manager.getPage(browser, "stale-history")).evaluate(() => { document.title = "Stale navigation decision"; });
    await expect(action("stale-history", { kind: "back", fromState: observed.stateId, strictState: true }))
      .rejects.toMatchObject({ code: "STALE_STATE" });
    expect((await manager.getPage(browser, "stale-history")).url()).toContain("/document-target");
  });

  it("returns PAGE_CLOSED with a safe page-aware recovery command and navigation journal", async () => {
    const pageName = "closing'; Remove-Item C:\\sensitive " + "q".repeat(180);
    await action(pageName, { kind: "navigate", url: fixture.mainUrl });
    const page = await manager.getPage(browser, pageName);
    let caught: any;
    try { await executeInteractiveAction(manager, {
      id: "closing-history-back", type: "interactive", protocolVersion: 2, browser,
      page: pageName, action: { kind: "back" },
    }, { beforeTrustedInput: () => page.close() }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "PAGE_CLOSED", details: { attemptJournal: [expect.objectContaining({ inputMethod: "navigation", reason: "page-closed" })] } });
    expect(caught.nextCommands).toEqual([observeRecoveryCommand(pageName)]);
  });

  it("uploads only a controlled regular file and returns basename/size without content", async () => {
    const secret = "UPLOAD_CONTENT_MUST_NOT_LEAK";
    const controlled = await writeDevBrowserTempFile("uploads/fixture-upload.txt", secret);
    await action("upload", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("upload", "Upload fixture");
    const result = await action("upload", { kind: "upload", ref, file: controlled });

    expect(result.uploaded).toMatchObject({ ref, filename: "fixture-upload.txt", bytes: Buffer.byteLength(secret), selected: true });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(controlled);
    expect(await manager.getPage(browser, "upload").then((page) => page.getByTestId("file-name").textContent())).toBe("fixture-upload.txt");
  });

  it("preserves protocol v1 upload compatibility without leaking the source", async () => {
    const controlled = await writeDevBrowserTempFile("uploads/v1-upload.txt", "V1_SECRET_CONTENT");
    await action("upload-v1", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("upload-v1", "Upload fixture");
    const result = await executeInteractiveAction(manager, {
      id: "upload-v1", type: "interactive", protocolVersion: 1, browser, page: "upload-v1",
      action: { kind: "upload", ref, file: controlled },
    });
    expect(result.uploaded).toMatchObject({ filename: "v1-upload.txt", selected: true });
    expect(JSON.stringify(result)).not.toContain(controlled);
    expect(result.snapshot).toBeTypeOf("string");
  });

  it("rejects outside-root, directory, missing, and oversized upload inputs before chooser dispatch", async () => {
    await action("upload-reject", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("upload-reject", "Upload fixture");
    const outside = path.join(fixture.uploadRoot, "outside.txt");
    await writeDevBrowserTempFile("uploads/oversized.bin", new Uint8Array(10_000_001));
    const invalid = [
      outside,
      DEV_BROWSER_TMP_DIR,
      path.join(DEV_BROWSER_TMP_DIR, "missing.txt"),
      path.join(DEV_BROWSER_TMP_DIR, "uploads", "oversized.bin"),
      `${DEV_BROWSER_TMP_DIR}${path.sep}uploads${path.sep}..${path.sep}uploads${path.sep}oversized.bin`,
    ];
    for (const file of invalid) {
      await expect(action("upload-reject", { kind: "upload", ref, file })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTEXT" });
    }
    expect(await manager.getPage(browser, "upload-reject").then((page) => page.getByTestId("file-name").textContent())).toBe("No file");
  });

  it("rejects file-chooser waits for direct uploads without selecting a file", async () => {
    await action("upload-chooser", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("upload-chooser", "Upload fixture");
    const controlled = await writeDevBrowserTempFile("uploads/direct-upload.txt", "safe");
    await expect(action("upload-chooser", { kind: "upload", ref, file: controlled, wait: { mode: "all", timeoutMs: 100, conditions: [{ kind: "fileChooser" }] } }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_CONTEXT", details: { attemptJournal: expect.any(Array) } });
    expect(await manager.getPage(browser, "upload-chooser").then((page) => page.getByTestId("file-name").textContent())).toBe("No file");
  });

  it("quotes malicious page names in upload recovery commands", async () => {
    const maliciousPage = "x'; Remove-Item C:\\sensitive " + "z".repeat(200);
    await action(maliciousPage, { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed(maliciousPage, "Upload fixture");
    let caught: any;
    try { await action(maliciousPage, { kind: "upload", ref, file: path.join(fixture.uploadRoot, "outside.txt") }); }
    catch (error) { caught = error; }
    expect(caught.nextCommands).toEqual([observeRecoveryCommand(maliciousPage)]);
  });

  it("rejects a symlinked upload without exposing its target", async () => {
    await action("upload-symlink", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("upload-symlink", "Upload fixture");
    const target = await writeDevBrowserTempFile("uploads/symlink-target.txt", "SYMLINK_SECRET");
    const link = path.join(DEV_BROWSER_TMP_DIR, "uploads", "symlink-source.txt");
    await rm(link, { force: true });
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(action("upload-symlink", { kind: "upload", ref, file: link })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTEXT" });
    expect(await manager.getPage(browser, "upload-symlink").then((page) => page.getByTestId("file-name").textContent())).toBe("No file");
    await rm(link, { force: true });
  });

  it("journals a final upload race without selecting the file", async () => {
    await action("upload-race", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("upload-race", "Upload fixture");
    const controlled = await writeDevBrowserTempFile("uploads/race-upload.txt", "safe");
    const page = await manager.getPage(browser, "upload-race");
    await expect(executeInteractiveAction(manager, {
      id: "upload-race", type: "interactive", protocolVersion: 2, browser, page: "upload-race",
      action: { kind: "upload", ref, file: controlled },
    }, { beforeTrustedInput: () => page.close() }))
      .rejects.toMatchObject({ code: "PAGE_CLOSED", details: { attemptJournal: [expect.objectContaining({ inputMethod: "upload" })] } });
  });

  it("revalidates upload actionability after the final hook and never selects hidden or obscured targets", async () => {
    for (const [name, mutate, code] of [
      ["hidden", (element: HTMLInputElement) => { element.style.display = "none"; }, "TARGET_HIDDEN"],
      ["obscured", (element: HTMLInputElement) => {
        const box = element.getBoundingClientRect();
        const overlay = document.createElement("div");
        Object.assign(overlay.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: "99999" });
        document.body.append(overlay);
      }, "TARGET_OBSCURED"],
    ] as const) {
      const pageName = `upload-${name}`;
      await action(pageName, { kind: "navigate", url: fixture.mainUrl });
      const ref = await refNamed(pageName, "Upload fixture");
      const controlled = await writeDevBrowserTempFile(`uploads/${name}.txt`, "safe");
      const page = await manager.getPage(browser, pageName);
      await expect(executeInteractiveAction(manager, {
        id: pageName, type: "interactive", protocolVersion: 2, browser, page: pageName,
        action: { kind: "upload", ref, file: controlled },
      }, { beforeTrustedInput: () => page.getByTestId("file-input").evaluate(mutate) }))
        .rejects.toMatchObject({ code, details: { attemptJournal: expect.any(Array) } });
      expect(await page.getByTestId("file-name").textContent()).toBe("No file");
    }
  });

  it("performs the final upload lease check after the hook with zero file selection", async () => {
    const pageName = "upload-lease";
    await action(pageName, { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed(pageName, "Upload fixture");
    const controlled = await writeDevBrowserTempFile("uploads/lease.txt", "safe");
    const page = await manager.getPage(browser, pageName);
    let lease: ReturnType<typeof pageLeases.open> | undefined;
    try {
      await expect(executeInteractiveAction(manager, {
        id: pageName, type: "interactive", protocolVersion: 2, browser, page: pageName,
        action: { kind: "upload", ref, file: controlled },
      }, { beforeTrustedInput: () => { lease = pageLeases.open(browser, pageName, 300); } }))
        .rejects.toMatchObject({ code: "LEASE_CONFLICT", details: { attemptJournal: expect.any(Array) } });
      expect(await page.getByTestId("file-name").textContent()).toBe("No file");
    } finally {
      if (lease) pageLeases.close(lease.sessionId);
    }
  });

  it("saves downloads collision-safely inside the controlled root", async () => {
    await action("download", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("download", "Download fixture");
    const click = { kind: "click", ref, method: "locator", wait: { mode: "all", timeoutMs: 3_000, conditions: [{ kind: "download" }] } };
    const first = await action("download", click);
    const second = await action("download", click);
    expect(first.download).toMatchObject({ bytes: 31, originatingAction: "click" });
    expect(first.download?.filename).toMatch(/^agent-fixture(?:-\d+)?\.txt$/);
    expect(second.download?.path).not.toBe(first.download?.path);
    for (const saved of [first.download?.path, second.download?.path]) {
      expect(saved?.startsWith(`${path.resolve(DEV_BROWSER_TMP_DIR)}${path.sep}`)).toBe(true);
      expect((await stat(saved!)).isFile()).toBe(true);
      expect(await readFile(saved!, "utf8")).toContain("deterministic fixture download");
      await rm(saved!, { force: true });
    }
  }, 10_000);

  it("rejects traversal download names and cleans interrupted artifacts with a journal", async () => {
    for (const unsafe of ["../escape.txt", "sub/escape.txt", "C:\\escape.txt"]) {
      await expect(reserveUniqueDownloadFile(unsafe)).rejects.toThrow(/unsafe/i);
    }
    await action("download-failure", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("download-failure", "Interrupted download");
    const downloadDir = path.join(DEV_BROWSER_TMP_DIR, "downloads");
    const before = new Set(await readdir(downloadDir).catch(() => []));
    await expect(action("download-failure", { kind: "click", ref, method: "locator", wait: { mode: "all", timeoutMs: 3_000, conditions: [{ kind: "download" }] } }))
      .rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { attemptJournal: expect.arrayContaining([expect.objectContaining({ reason: "download-failed" })]) } });
    const leaked = (await readdir(downloadDir)).filter((name) => name.startsWith("interrupted") && !before.has(name));
    expect(leaked).toEqual([]);
  });

  it("cleans download listeners after a typed timeout", async () => {
    await action("download-timeout", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("download-timeout", "Connect");
    const page = await manager.getPage(browser, "download-timeout");
    const emitter = page as unknown as { listenerCount(event: string): number };
    const baseline = emitter.listenerCount("download");
    await expect(action("download-timeout", { kind: "click", ref, method: "locator", wait: { mode: "all", timeoutMs: 50, conditions: [{ kind: "download" }] } }))
      .rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(emitter.listenerCount("download")).toBe(baseline);
  });

  it("captures and saves a keyboard-triggered download without an explicit wait", async () => {
    await action("download-keyboard", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("download-keyboard", "Download fixture");
    const result = await action("download-keyboard", { kind: "press", ref, key: "Enter" });
    expect(result.download).toMatchObject({ originatingAction: "press", bytes: 31 });
    await rm(result.download!.path, { force: true });
  });

  it("returns actionable popup metadata and registers its target", async () => {
    await action("popup", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("popup", "Open popup");
    const result = await action("popup", { kind: "click", ref, method: "locator", wait: { mode: "all", timeoutMs: 3_000, conditions: [{ kind: "popup" }] } });
    expect(result.popup).toMatchObject({ targetId: expect.any(String), url: expect.stringContaining("/popup-target"), title: "Agent reliability fixture", openerPage: "popup", focusChanged: expect.any(Boolean), currentPageChanged: false, nextCommand: expect.stringContaining("observe --page") });
    expect((await manager.listPages(browser)).some((candidate) => candidate.id === result.popup?.targetId)).toBe(true);
  });

  it("redacts OAuth codes and sensitive fragments from popup metadata", async () => {
    await action("popup-redaction", { kind: "navigate", url: fixture.mainUrl });
    const page = await manager.getPage(browser, "popup-redaction");
    await page.getByTestId("popup-link").evaluate((link) => {
      (link as HTMLAnchorElement).href = "/popup-target?code=TITLE_SECRET&title=TITLE_SECRET#access_token=FRAGMENT_SECRET";
    });
    const ref = await refNamed("popup-redaction", "Open popup");
    const result = await action("popup-redaction", { kind: "click", ref, method: "locator" });
    const serialized = JSON.stringify(result.popup);
    expect(serialized).not.toContain("FRAGMENT_SECRET");
    expect(serialized).not.toContain("TITLE_SECRET");
  });

  it("returns POPUP_OPENED with journal evidence when a popup interrupts another wait", async () => {
    await action("popup-unexpected", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("popup-unexpected", "Open popup");
    await expect(action("popup-unexpected", { kind: "click", ref, method: "locator", wait: { mode: "all", timeoutMs: 100, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "never appears" }] } }))
      .rejects.toMatchObject({ code: "POPUP_OPENED", details: { attemptJournal: expect.any(Array), waitResult: expect.any(Object) } });
  });

  it("returns POPUP_OPENED when keyboard press interrupts another short wait", async () => {
    await action("popup-unexpected-press", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("popup-unexpected-press", "Open popup");
    await expect(action("popup-unexpected-press", { kind: "press", ref, key: "Enter", wait: { mode: "all", timeoutMs: 100, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "never appears" }] } }))
      .rejects.toMatchObject({ code: "POPUP_OPENED", details: { attemptJournal: expect.any(Array), waitResult: expect.any(Object) } });
  });

  it("captures a keyboard-opened popup before press dispatch and removes listeners", async () => {
    await action("popup-keyboard", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("popup-keyboard", "Open popup");
    const page = await manager.getPage(browser, "popup-keyboard");
    const emitter = page as unknown as { listenerCount(event: string): number };
    const baseline = emitter.listenerCount("popup");
    const result = await action("popup-keyboard", { kind: "press", ref, key: "Enter" });
    expect(result.popup).toMatchObject({ targetId: expect.any(String), openerPage: "popup-keyboard" });
    expect(emitter.listenerCount("popup")).toBe(baseline);
  });

  it("captures a delayed popup within the bounded implicit click window", async () => {
    await action("popup-delayed", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("popup-delayed", "Open delayed popup");
    const page = await manager.getPage(browser, "popup-delayed");
    const baseline = (page as unknown as { listenerCount(event: string): number }).listenerCount("popup");
    const result = await action("popup-delayed", { kind: "click", ref, method: "locator" });
    expect(result.popup).toMatchObject({ targetId: expect.any(String), url: expect.stringContaining("/popup-target") });
    expect((page as unknown as { listenerCount(event: string): number }).listenerCount("popup")).toBe(baseline);
  });

  it("bounds unavailable popup metadata and attaches the action journal", async () => {
    await action("popup-metadata-timeout", { kind: "navigate", url: fixture.mainUrl });
    const ref = await refNamed("popup-metadata-timeout", "Open popup");
    const page = await manager.getPage(browser, "popup-metadata-timeout");
    const emitter = page as unknown as { listenerCount(event: string): number };
    const baseline = emitter.listenerCount("popup");
    const spy = vi.spyOn(page.context(), "newCDPSession").mockImplementation(
      async () => new Promise<never>(() => {})
    );
    const started = Date.now();
    try {
      await expect(action("popup-metadata-timeout", { kind: "click", ref, method: "locator" }))
        .rejects.toMatchObject({ code: "POPUP_OPENED", details: { attemptJournal: expect.any(Array) } });
      // Preserve the bounded deadline while allowing scheduler contention in the full Playwright suite.
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(emitter.listenerCount("popup")).toBe(baseline);
    } finally {
      spy.mockRestore();
    }
  });
});
