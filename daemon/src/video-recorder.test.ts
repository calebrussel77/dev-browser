import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentProtocolError, agentErrorExitCode } from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import { stopBrowserManagerAndRemoveDirectory } from "./browser-test-cleanup.js";
import { parseRequest, serialize } from "./protocol.js";
import {
  DEFAULT_CHAPTER_DURATION_MS,
  DEFAULT_MAX_DURATION_SECONDS,
  defaultVideoPath,
  VideoRecorderRegistry,
  VIDEO_OUTPUT_DIR,
} from "./video-recorder.js";

/** Matroska/WebM files always open with the EBML magic number. */
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

const browserName = "video-recorder";

async function expectPlayableWebm(filePath: string): Promise<void> {
  const stats = await stat(filePath);
  expect(stats.size).toBeGreaterThan(0);
  const header = (await readFile(filePath)).subarray(0, EBML_SIGNATURE.length);
  expect(header.equals(EBML_SIGNATURE)).toBe(true);
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false
  );
}

/** Polls a condition the daemon reaches on its own (a cap firing, a page-close
 * finalization) instead of sleeping for a guessed duration. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected daemon state");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function expectAgentError(
  operation: Promise<unknown>,
  code: string
): Promise<AgentProtocolError> {
  const error = await operation.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(AgentProtocolError);
  const agentError = error as AgentProtocolError;
  expect(agentError.code).toBe(code);
  return agentError;
}

describe("video protocol requests", () => {
  it("accepts start with defaults and optional recording fields", () => {
    const parsed = parseRequest(
      JSON.stringify({ id: "req-1", type: "video", action: "start" })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.request).toMatchObject({
      type: "video",
      action: "start",
      browser: "default",
      page: "main",
    });

    const sized = parseRequest(
      JSON.stringify({
        id: "req-2",
        type: "video",
        action: "start",
        page: "feed",
        file: "C:/recordings/flow.webm",
        size: { width: 1280, height: 800 },
      })
    );
    expect(sized.success).toBe(true);
  });

  it("accepts chapter with a title and optional card fields", () => {
    const parsed = parseRequest(
      JSON.stringify({
        id: "req-chapter",
        type: "video",
        action: "chapter",
        title: "Sign in",
        description: "Entering credentials",
        durationMs: 2_500,
      })
    );
    expect(parsed.success).toBe(true);
    expect(
      parseRequest(JSON.stringify({ id: "req-chapter-2", type: "video", action: "chapter" }))
        .success
    ).toBe(false);
  });

  it("accepts a per-recording max duration within bounds", () => {
    expect(
      parseRequest(
        JSON.stringify({
          id: "req-cap",
          type: "video",
          action: "start",
          maxDurationSeconds: 30,
        })
      ).success
    ).toBe(true);
    expect(
      parseRequest(
        JSON.stringify({
          id: "req-cap-2",
          type: "video",
          action: "start",
          maxDurationSeconds: 0,
        })
      ).success
    ).toBe(false);
  });

  it("accepts stop and rejects unknown actions or malformed sizes", () => {
    expect(parseRequest(JSON.stringify({ id: "req-3", type: "video", action: "stop" })).success).toBe(
      true
    );
    expect(
      parseRequest(JSON.stringify({ id: "req-4", type: "video", action: "pause" })).success
    ).toBe(false);
    expect(
      parseRequest(
        JSON.stringify({
          id: "req-5",
          type: "video",
          action: "start",
          size: { width: 0, height: 800 },
        })
      ).success
    ).toBe(false);
  });
});

describe("video result serialization", () => {
  const outsideTemp =
    process.platform === "win32"
      ? "C:\\Users\\agent\\recordings\\flow.webm"
      : "/Users/agent/recordings/flow.webm";

  it("keeps the absolute output path of a video result intact", () => {
    const serialized = serialize({
      id: "req-1",
      type: "result",
      data: { action: "start", browser: "default", page: "main", path: outsideTemp },
    });
    expect(JSON.parse(serialized).data.path).toBe(outsideTemp);
  });

  it("still masks home paths in results that are not video results", () => {
    const serialized = serialize({
      id: "req-2",
      type: "result",
      data: { action: "shot", screenshotPath: outsideTemp },
    });
    expect(JSON.parse(serialized).data.screenshotPath).toBe("[path]");
  });
});

describe("default recording paths", () => {
  it("lands under the dev-browser videos directory with a sortable name", () => {
    const generated = defaultVideoPath("feed", Date.parse("2026-07-25T06:30:24.123Z"));
    expect(path.dirname(generated)).toBe(VIDEO_OUTPUT_DIR);
    expect(path.basename(generated)).toBe("feed-2026-07-25T06-30-24-123Z.webm");
  });

  it("sanitizes page names that are not filename-safe", () => {
    const generated = defaultVideoPath("../etc/passwd");
    expect(path.dirname(generated)).toBe(VIDEO_OUTPUT_DIR);
    expect(path.basename(generated)).not.toContain("/");
    expect(path.basename(generated)).not.toContain("..");
  });
});

describe.sequential("video recording against a real browser", () => {
  let browserRootDir = "";
  let outputDir = "";
  let manager: BrowserManager;
  let recordings: VideoRecorderRegistry;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-video-"));
    outputDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-video-out-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
    recordings = new VideoRecorderRegistry();
  }, 180_000);

  afterAll(async () => {
    await stopBrowserManagerAndRemoveDirectory(manager, browserRootDir);
    await rm(outputDir, { recursive: true, force: true });
  }, 180_000);

  it("records a page end to end and returns the absolute output path", async () => {
    const page = await manager.getPage(browserName, "recorded");
    await page.setContent("<h1 style='font-size:64px'>Recording</h1>");
    const outputPath = path.join(outputDir, "flow.webm");

    const started = await recordings.start({
      browser: browserName,
      page: "recorded",
      pageObject: page,
      file: outputPath,
      size: { width: 640, height: 480 },
    });
    expect(started.path).toBe(outputPath);
    expect(path.isAbsolute(started.path)).toBe(true);

    await page.setContent("<h1 style='font-size:64px'>Second frame</h1>");
    await page.waitForTimeout(2_000);

    const stopped = await recordings.stop({ browser: browserName, page: "recorded" });
    expect(stopped.path).toBe(outputPath);
    expect(stopped.durationMs).toBeGreaterThan(0);
    await expectPlayableWebm(outputPath);
    expect(recordings.isRecording({ browser: browserName, page: "recorded" })).toBe(false);
  }, 120_000);

  it("rejects a second start on a recording page with a typed error", async () => {
    const page = await manager.getPage(browserName, "guarded");
    const outputPath = path.join(outputDir, "guarded.webm");
    await recordings.start({
      browser: browserName,
      page: "guarded",
      pageObject: page,
      file: outputPath,
    });

    const error = await expectAgentError(
      recordings.start({
        browser: browserName,
        page: "guarded",
        pageObject: page,
        file: path.join(outputDir, "guarded-2.webm"),
      }),
      "VIDEO_ALREADY_RECORDING"
    );
    expect(error.recoverable).toBe(true);
    expect(agentErrorExitCode(error.code)).toBe(6);

    await recordings.stop({ browser: browserName, page: "guarded" });
    await expectPlayableWebm(outputPath);
  }, 120_000);

  it("rejects stop on a page with no active recording", async () => {
    const error = await expectAgentError(
      recordings.stop({ browser: browserName, page: "never-recorded" }),
      "VIDEO_NOT_RECORDING"
    );
    expect(agentErrorExitCode(error.code)).toBe(6);
  }, 60_000);

  it("marks chapters into an active recording and blocks for the card duration", async () => {
    const page = await manager.getPage(browserName, "chaptered");
    await page.setContent("<h1 style='font-size:64px'>Chaptered</h1>");
    const outputPath = path.join(outputDir, "chaptered.webm");

    await recordings.start({
      browser: browserName,
      page: "chaptered",
      pageObject: page,
      file: outputPath,
    });

    // The card must be genuinely composited while it is up, not merely
    // requested: capture the frame mid-chapter and compare it with the frames
    // before and after.
    const beforeCard = await page.screenshot();
    const startedAt = Date.now();
    const pending = recordings.chapter({
      browser: browserName,
      page: "chaptered",
      title: "Sign in",
      description: "Entering credentials",
      durationMs: 1_500,
    });
    await page.waitForTimeout(500);
    const duringCard = await page.screenshot();
    const chapter = await pending;
    const elapsed = Date.now() - startedAt;
    await page.waitForTimeout(300);
    const afterCard = await page.screenshot();

    expect(duringCard.equals(beforeCard)).toBe(false);
    expect(afterCard.equals(beforeCard)).toBe(true);
    expect(chapter).toMatchObject({
      title: "Sign in",
      description: "Entering credentials",
      durationMs: 1_500,
    });
    expect(elapsed).toBeGreaterThanOrEqual(1_400);

    await page.setContent("<h1 style='font-size:64px'>After the chapter</h1>");
    const second = await recordings.chapter({
      browser: browserName,
      page: "chaptered",
      title: "Result",
    });
    expect(second.durationMs).toBe(DEFAULT_CHAPTER_DURATION_MS);

    await recordings.stop({ browser: browserName, page: "chaptered" });
    await expectPlayableWebm(outputPath);
  }, 120_000);

  it("rejects a chapter on a page with no active recording", async () => {
    const error = await expectAgentError(
      recordings.chapter({
        browser: browserName,
        page: "never-recorded",
        title: "Nothing to mark",
      }),
      "VIDEO_NOT_RECORDING"
    );
    expect(agentErrorExitCode(error.code)).toBe(6);
  }, 60_000);

  it("finalizes a capped recording on its own and reports the cap once", async () => {
    const page = await manager.getPage(browserName, "capped");
    await page.setContent("<h1 style='font-size:64px'>Capped</h1>");
    const outputPath = path.join(outputDir, "capped.webm");

    const started = await recordings.start({
      browser: browserName,
      page: "capped",
      pageObject: page,
      file: outputPath,
      maxDurationSeconds: 1,
    });
    expect(started.maxDurationSeconds).toBe(1);

    // No further command: the daemon must finalize the file by itself.
    await waitFor(
      () => !recordings.isRecording({ browser: browserName, page: "capped" }),
      15_000
    );
    await waitFor(() => fileExists(outputPath), 15_000);
    await expectPlayableWebm(outputPath);

    const capped = await expectAgentError(
      recordings.stop({ browser: browserName, page: "capped" }),
      "VIDEO_LIMIT_REACHED"
    );
    expect(agentErrorExitCode(capped.code)).toBe(6);
    expect(capped.message).toContain("max duration");
    expect(capped.details).toMatchObject({ path: outputPath, maxDurationSeconds: 1 });

    // The note is reported once; the page is then a clean slate again.
    await expectAgentError(
      recordings.stop({ browser: browserName, page: "capped" }),
      "VIDEO_NOT_RECORDING"
    );
  }, 120_000);

  it("keeps recording while a longer cap has not expired", async () => {
    const page = await manager.getPage(browserName, "long-cap");
    await page.setContent("<h1 style='font-size:64px'>Long cap</h1>");
    const outputPath = path.join(outputDir, "long-cap.webm");

    const started = await recordings.start({
      browser: browserName,
      page: "long-cap",
      pageObject: page,
      file: outputPath,
      maxDurationSeconds: 3_600,
    });
    expect(started.maxDurationSeconds).toBe(3_600);

    await page.waitForTimeout(1_500);
    expect(recordings.isRecording({ browser: browserName, page: "long-cap" })).toBe(true);

    await recordings.stop({ browser: browserName, page: "long-cap" });
    await expectPlayableWebm(outputPath);
  }, 120_000);

  it("applies the default cap when none is requested", async () => {
    const page = await manager.getPage(browserName, "default-cap");
    const outputPath = path.join(outputDir, "default-cap.webm");
    const started = await recordings.start({
      browser: browserName,
      page: "default-cap",
      pageObject: page,
      file: outputPath,
    });
    expect(started.maxDurationSeconds).toBe(DEFAULT_MAX_DURATION_SECONDS);
    await recordings.stop({ browser: browserName, page: "default-cap" });
  }, 120_000);

  it("finalizes a valid file when the recorded page closes mid-recording", async () => {
    const page = await manager.getPage(browserName, "closed-mid-recording");
    await page.setContent("<h1 style='font-size:64px'>Closing</h1>");
    const outputPath = path.join(outputDir, "closed.webm");

    await recordings.start({
      browser: browserName,
      page: "closed-mid-recording",
      pageObject: page,
      file: outputPath,
    });
    await page.waitForTimeout(1_500);
    await page.close();

    await waitFor(
      () => !recordings.isRecording({ browser: browserName, page: "closed-mid-recording" }),
      15_000
    );
    // A shutdown that lands on top of an in-flight page-close finalization
    // must wait for that write instead of racing it.
    await recordings.finalizeAll();
    await waitFor(() => fileExists(outputPath), 15_000);
    await expectPlayableWebm(outputPath);
  }, 120_000);

  it("finalizes every active recording on shutdown", async () => {
    const page = await manager.getPage(browserName, "shutdown-recording");
    await page.setContent("<h1 style='font-size:64px'>Shutting down</h1>");
    const outputPath = path.join(outputDir, "shutdown.webm");

    await recordings.start({
      browser: browserName,
      page: "shutdown-recording",
      pageObject: page,
      file: outputPath,
    });
    await page.waitForTimeout(1_500);

    await recordings.finalizeAll();

    expect(recordings.activeCount()).toBe(0);
    await expectPlayableWebm(outputPath);
  }, 120_000);

  it("wakes an occluded window before recording a connected browser", async () => {
    const wakeCalls: string[] = [];
    const connectedRecordings = new VideoRecorderRegistry({
      ensureVisible: async (_page, pageName) => {
        wakeCalls.push(pageName);
        return {
          method: "window-restore",
          warnings: ["The browser window was fully covered by other windows"],
        };
      },
    });

    const page = await manager.getPage(browserName, "connected-like");
    await page.setContent("<h1 style='font-size:64px'>Connected</h1>");
    const outputPath = path.join(outputDir, "connected.webm");

    const started = await connectedRecordings.start({
      browser: browserName,
      page: "connected-like",
      pageObject: page,
      file: outputPath,
      connected: true,
    });

    expect(wakeCalls).toEqual(["connected-like"]);
    expect(started.warnings).toEqual(["The browser window was fully covered by other windows"]);

    await page.waitForTimeout(1_000);
    await connectedRecordings.stop({ browser: browserName, page: "connected-like" });
    await expectPlayableWebm(outputPath);
  }, 120_000);

  it("never attempts a wake for a launched browser", async () => {
    const wakeCalls: string[] = [];
    const launchedRecordings = new VideoRecorderRegistry({
      ensureVisible: async (_page, pageName) => {
        wakeCalls.push(pageName);
        return null;
      },
    });

    const page = await manager.getPage(browserName, "launched-like");
    const outputPath = path.join(outputDir, "launched.webm");

    const started = await launchedRecordings.start({
      browser: browserName,
      page: "launched-like",
      pageObject: page,
      file: outputPath,
    });

    expect(wakeCalls).toEqual([]);
    expect(started.warnings).toBeUndefined();

    await launchedRecordings.stop({ browser: browserName, page: "launched-like" });
  }, 120_000);

  it("records two pages in parallel into separate files", async () => {
    const first = await manager.getPage(browserName, "parallel-one");
    const second = await manager.getPage(browserName, "parallel-two");
    await first.setContent("<h1 style='font-size:64px'>One</h1>");
    await second.setContent("<h1 style='font-size:64px'>Two</h1>");

    const firstPath = path.join(outputDir, "parallel-one.webm");
    const secondPath = path.join(outputDir, "parallel-two.webm");

    await recordings.start({
      browser: browserName,
      page: "parallel-one",
      pageObject: first,
      file: firstPath,
    });
    await recordings.start({
      browser: browserName,
      page: "parallel-two",
      pageObject: second,
      file: secondPath,
    });
    expect(recordings.activeCount()).toBe(2);

    await first.waitForTimeout(1_500);

    await recordings.stop({ browser: browserName, page: "parallel-one" });
    await recordings.stop({ browser: browserName, page: "parallel-two" });

    await expectPlayableWebm(firstPath);
    await expectPlayableWebm(secondPath);
  }, 120_000);
});
