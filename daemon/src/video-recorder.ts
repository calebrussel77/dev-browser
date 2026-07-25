import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { DEV_BROWSER_TMP_DIR } from "./temp-files.js";

/** Default home for recordings started without an explicit output file. */
export const VIDEO_OUTPUT_DIR = path.join(DEV_BROWSER_TMP_DIR, "videos");

/** A forgotten recording must not keep a long-lived daemon encoding video for
 * hours. Ten minutes covers any realistic agent journey; deliberate demos raise
 * it per recording. */
export const DEFAULT_MAX_DURATION_SECONDS = 600;

/** Playwright's own default for a chapter card. Mirrored here so the result
 * reports the duration the caller actually got, not `undefined`. */
export const DEFAULT_CHAPTER_DURATION_MS = 2_000;

export interface VideoSize {
  width: number;
  height: number;
}

export interface VideoTarget {
  browser: string;
  page: string;
}

export interface VideoStartOptions extends VideoTarget {
  pageObject: Page;
  file?: string;
  size?: VideoSize;
  maxDurationSeconds?: number;
}

export interface VideoStartResult {
  path: string;
  startedAt: string;
  maxDurationSeconds: number;
}

export interface VideoStopResult {
  path: string;
  startedAt: string;
  durationMs: number;
}

export interface VideoChapterOptions extends VideoTarget {
  title: string;
  description?: string;
  durationMs?: number;
}

export interface VideoChapterResult {
  title: string;
  description?: string;
  durationMs: number;
}

/** Why a recording stopped. Only `max-duration` leaves a note for the agent:
 * the others are either explicit or accompany the end of the session. */
type FinalizationReason = "stop" | "max-duration" | "page-closed" | "shutdown";

/** The client-side handle Playwright keeps for the recording artifact. It is
 * not part of the public `Screencast` surface, but it is the only way to
 * finalize a recording whose page has already gone away — `screencast.stop()`
 * needs a live page, while the artifact survives it. */
interface RecordingArtifact {
  saveAs(destination: string): Promise<void>;
  _initializer?: { absolutePath?: string };
}

interface ActiveRecording extends VideoTarget {
  pageObject: Page;
  outputPath: string;
  startedAt: number;
  maxDurationSeconds: number;
  timer: NodeJS.Timeout;
  onPageClose: () => void;
  artifact?: RecordingArtifact;
  finalizing?: Promise<void>;
}

interface CapFinalizedNote {
  path: string;
  maxDurationSeconds: number;
  finalizedAt: number;
}

/** Page names are agent-chosen and may be target ids or arbitrary labels, so a
 * default filename derived from one keeps only characters that are safe in
 * every filesystem and collapses dot runs that would read as traversal. */
function safeSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 60);
  return sanitized.length > 0 ? sanitized : "page";
}

/** `2026-07-25T06-30-24-123Z` — sortable, filename-safe, collision-resistant. */
function fileTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

export function defaultVideoPath(page: string, now: number = Date.now()): string {
  return path.join(VIDEO_OUTPUT_DIR, `${safeSegment(page)}-${fileTimestamp(now)}.webm`);
}

/** Playwright encodes WebM through the ffmpeg binary from its own registry, so
 * a runtime without it fails deep inside the screencast start. Recognize it and
 * point at the command that installs it instead of leaking the internal path. */
function isMissingEncoderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ffmpeg/i.test(message);
}

function recordingArtifactOf(page: Page): RecordingArtifact | undefined {
  return (page.screencast as unknown as { _artifact?: RecordingArtifact })._artifact;
}

export class VideoRecorderRegistry {
  readonly #active = new Map<string, ActiveRecording>();
  readonly #capFinalized = new Map<string, CapFinalizedNote>();

  #key(browser: string, page: string): string {
    return `${browser}\0${page}`;
  }

  isRecording(target: VideoTarget): boolean {
    return this.#active.has(this.#key(target.browser, target.page));
  }

  activeCount(): number {
    return this.#active.size;
  }

  async start(options: VideoStartOptions): Promise<VideoStartResult> {
    const key = this.#key(options.browser, options.page);
    this.#assertNoCapFinalization(key, options.page);

    const existing = this.#active.get(key);
    if (existing) {
      throw new AgentProtocolError(
        "VIDEO_ALREADY_RECORDING",
        `Page "${options.page}" is already recording to ${existing.outputPath}`,
        true,
        {
          details: { page: options.page, path: existing.outputPath },
          nextCommands: [`dev-browser video stop --page ${options.page}`],
        }
      );
    }

    const startedAt = Date.now();
    const maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    const outputPath = options.file
      ? path.resolve(options.file)
      : defaultVideoPath(options.page, startedAt);
    await mkdir(path.dirname(outputPath), { recursive: true });

    try {
      await options.pageObject.screencast.start({
        path: outputPath,
        ...(options.size ? { size: options.size } : {}),
      });
    } catch (error) {
      if (isMissingEncoderError(error)) {
        throw new AgentProtocolError(
          "VIDEO_ENCODER_MISSING",
          "The Playwright ffmpeg encoder required for video recording is not installed",
          true,
          { nextCommands: ["dev-browser install"] }
        );
      }
      throw error;
    }

    const timer = setTimeout(() => {
      void this.#finalize(key, "max-duration");
    }, maxDurationSeconds * 1_000);
    timer.unref();

    const onPageClose = () => {
      void this.#finalize(key, "page-closed");
    };
    options.pageObject.once("close", onPageClose);

    this.#active.set(key, {
      browser: options.browser,
      page: options.page,
      pageObject: options.pageObject,
      outputPath,
      startedAt,
      maxDurationSeconds,
      timer,
      onPageClose,
      artifact: recordingArtifactOf(options.pageObject),
    });

    return {
      path: outputPath,
      startedAt: new Date(startedAt).toISOString(),
      maxDurationSeconds,
    };
  }

  /** Blocks for the card's duration so the marker is genuinely on screen in
   * the finished video rather than a frame that the encoder may drop. */
  async chapter(options: VideoChapterOptions): Promise<VideoChapterResult> {
    const key = this.#key(options.browser, options.page);
    this.#assertNoCapFinalization(key, options.page);

    const recording = this.#active.get(key);
    if (!recording) {
      throw this.#notRecording(options.page);
    }

    const durationMs = options.durationMs ?? DEFAULT_CHAPTER_DURATION_MS;
    await recording.pageObject.screencast.showChapter(options.title, {
      ...(options.description ? { description: options.description } : {}),
      duration: durationMs,
    });

    return {
      title: options.title,
      ...(options.description ? { description: options.description } : {}),
      durationMs,
    };
  }

  async stop(target: VideoTarget): Promise<VideoStopResult> {
    const key = this.#key(target.browser, target.page);
    this.#assertNoCapFinalization(key, target.page);

    const recording = this.#active.get(key);
    if (!recording) {
      throw this.#notRecording(target.page);
    }

    await this.#finalize(key, "stop");

    return {
      path: recording.outputPath,
      startedAt: new Date(recording.startedAt).toISOString(),
      durationMs: Date.now() - recording.startedAt,
    };
  }

  /** Finalizes every recording for one browser (or all of them) before the
   * browser goes away, because a recording whose browser is already gone can
   * only be salvaged from the encoder's own temp file. */
  async finalizeAll(browser?: string): Promise<void> {
    const keys = [...this.#active.entries()]
      .filter(([, recording]) => browser === undefined || recording.browser === browser)
      .map(([key]) => key);
    await Promise.allSettled(keys.map((key) => this.#finalize(key, "shutdown")));
  }

  /** Every exit path funnels through here so a recording is finalized exactly
   * once and always leaves a valid file behind. */
  async #finalize(key: string, reason: FinalizationReason): Promise<void> {
    const recording = this.#active.get(key);
    if (!recording) return;
    if (recording.finalizing) return recording.finalizing;

    recording.finalizing = (async () => {
      clearTimeout(recording.timer);
      recording.pageObject.off("close", recording.onPageClose);
      this.#active.delete(key);

      if (reason === "max-duration") {
        this.#capFinalized.set(key, {
          path: recording.outputPath,
          maxDurationSeconds: recording.maxDurationSeconds,
          finalizedAt: Date.now(),
        });
      }

      await this.#saveRecording(recording, reason);
    })();

    return recording.finalizing;
  }

  /** Three tiers, least to most degraded: a live page can stop the screencast
   * normally; a closed page still has a live artifact handle; a browser that is
   * gone leaves only the encoder's own output file to copy. */
  async #saveRecording(recording: ActiveRecording, reason: FinalizationReason): Promise<void> {
    const failures: unknown[] = [];

    if (!recording.pageObject.isClosed()) {
      try {
        await recording.pageObject.screencast.stop();
        return;
      } catch (error) {
        failures.push(error);
      }
    }

    if (recording.artifact) {
      try {
        await recording.artifact.saveAs(recording.outputPath);
        return;
      } catch (error) {
        failures.push(error);
      }
    }

    const encoderPath = recording.artifact?._initializer?.absolutePath;
    if (encoderPath) {
      try {
        await copyFile(encoderPath, recording.outputPath);
        return;
      } catch (error) {
        failures.push(error);
      }
    }

    // An explicit stop must surface its failure to the agent; the automatic
    // exit paths run without a caller to report to.
    if (reason === "stop") {
      throw failures[0] ?? new Error("The recording could not be finalized");
    }
  }

  #assertNoCapFinalization(key: string, page: string): void {
    const note = this.#capFinalized.get(key);
    if (!note) return;

    // Reported once, then cleared: the agent now knows why nothing was running
    // and the next start on this page is a clean slate.
    this.#capFinalized.delete(key);
    throw new AgentProtocolError(
      "VIDEO_LIMIT_REACHED",
      `The recording for page "${page}" reached its ${note.maxDurationSeconds}s max duration and was finalized to ${note.path}`,
      true,
      {
        details: {
          page,
          path: note.path,
          maxDurationSeconds: note.maxDurationSeconds,
          finalizedAt: new Date(note.finalizedAt).toISOString(),
        },
        nextCommands: [`dev-browser video start --page ${page}`],
      }
    );
  }

  #notRecording(page: string): AgentProtocolError {
    return new AgentProtocolError(
      "VIDEO_NOT_RECORDING",
      `Page "${page}" has no active video recording`,
      true,
      {
        details: { page },
        nextCommands: [`dev-browser video start --page ${page}`],
      }
    );
  }
}

export const videoRecordings = new VideoRecorderRegistry();
