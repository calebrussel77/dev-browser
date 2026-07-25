import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { DEV_BROWSER_TMP_DIR } from "./temp-files.js";

/** Default home for recordings started without an explicit output file. */
export const VIDEO_OUTPUT_DIR = path.join(DEV_BROWSER_TMP_DIR, "videos");

export interface VideoSize {
  width: number;
  height: number;
}

export interface VideoStartOptions {
  browser: string;
  page: string;
  pageObject: Page;
  file?: string;
  size?: VideoSize;
}

export interface VideoTarget {
  browser: string;
  page: string;
}

export interface VideoStartResult {
  path: string;
  startedAt: string;
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

/** Playwright's own default for a chapter card. Mirrored here so the result
 * reports the duration the caller actually got, not `undefined`. */
export const DEFAULT_CHAPTER_DURATION_MS = 2_000;

interface ActiveRecording {
  browser: string;
  page: string;
  pageObject: Page;
  outputPath: string;
  startedAt: number;
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

export class VideoRecorderRegistry {
  readonly #active = new Map<string, ActiveRecording>();

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

    this.#active.set(key, {
      browser: options.browser,
      page: options.page,
      pageObject: options.pageObject,
      outputPath,
      startedAt,
    });

    return { path: outputPath, startedAt: new Date(startedAt).toISOString() };
  }

  /** Blocks for the card's duration so the marker is genuinely on screen in
   * the finished video rather than a frame that the encoder may drop. */
  async chapter(options: VideoChapterOptions): Promise<VideoChapterResult> {
    const recording = this.#active.get(this.#key(options.browser, options.page));
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
    const recording = this.#active.get(key);
    if (!recording) {
      throw this.#notRecording(target.page);
    }

    this.#active.delete(key);
    await recording.pageObject.screencast.stop();

    return {
      path: recording.outputPath,
      startedAt: new Date(recording.startedAt).toISOString(),
      durationMs: Date.now() - recording.startedAt,
    };
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
