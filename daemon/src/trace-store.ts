import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { redactSensitive } from "./redaction.js";
import {
  DEV_BROWSER_TMP_DIR,
  readDevBrowserTempFile,
  resolveDevBrowserTempPath,
  writeDevBrowserTempFile,
} from "./temp-files.js";

export const TRACE_MAX_BYTES = 128_000;
export const TRACE_RETENTION = 20;
const TRACE_ID = /^[a-z0-9-]{8,80}$/;

export class TraceStore {
  readonly #relativeDirectory: string;
  #queue = Promise.resolve();

  constructor(relativeDirectory = "traces") {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(relativeDirectory)) {
      throw new Error("Trace directory must be a safe controlled name");
    }
    this.#relativeDirectory = relativeDirectory;
  }

  get absoluteDirectory(): string {
    return path.join(DEV_BROWSER_TMP_DIR, this.#relativeDirectory);
  }

  async #directory(): Promise<string> {
    const directory = await resolveDevBrowserTempPath(this.#relativeDirectory, { createParents: true });
    await mkdir(directory, { recursive: true });
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Trace directory is unsafe");
    return directory;
  }

  allocateId(): string {
    return `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  }

  async artifactPath(id: string, name: "before.png"): Promise<string> {
    if (!TRACE_ID.test(id)) throw new Error("Invalid trace id");
    return resolveDevBrowserTempPath(path.join(this.#relativeDirectory, `${id}-${name}`), {
      createParents: true,
    });
  }

  async save(record: Record<string, unknown>, allocatedId?: string): Promise<{ id: string; path: string }> {
    const run = async () => {
      const id = allocatedId ?? this.allocateId();
      if (!TRACE_ID.test(id)) throw new Error("Invalid trace id");
      const redacted = redactSensitive({ id, ...record });
      let serialized = JSON.stringify(redacted, null, 2);
      if (Buffer.byteLength(serialized) > TRACE_MAX_BYTES) {
        serialized = JSON.stringify(
          redactSensitive({
            id,
            actionId: record.actionId,
            action: record.action,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            durationMs: record.durationMs,
            truncated: true,
            diagnostics: "[truncated]",
          }),
          null,
          2
        );
      }
      const filePath = await writeDevBrowserTempFile(
        path.join(this.#relativeDirectory, `${id}.json`),
        serialized
      );
      await writeDevBrowserTempFile(path.join(this.#relativeDirectory, "LAST"), id);
      await this.#cleanup();
      return { id, path: filePath };
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async listIds(): Promise<string[]> {
    const directory = await this.#directory();
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && TRACE_ID.test(entry.name.slice(0, -5)))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
  }

  async read(requestedId: string): Promise<Record<string, unknown>> {
    let id = requestedId;
    if (id === "LAST") id = (await readDevBrowserTempFile(path.join(this.#relativeDirectory, "LAST"))).trim();
    if (!TRACE_ID.test(id)) throw new Error("Invalid trace id");
    const raw = await readDevBrowserTempFile(path.join(this.#relativeDirectory, `${id}.json`));
    return redactSensitive(JSON.parse(raw)) as Record<string, unknown>;
  }

  async #cleanup(): Promise<void> {
    const directory = await this.#directory();
    const entries = await readdir(directory, { withFileTypes: true });
    const traces = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && TRACE_ID.test(entry.name.slice(0, -5)))
        .map(async (entry) => ({ entry, stats: await lstat(path.join(directory, entry.name)) }))
    );
    traces.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs || right.entry.name.localeCompare(left.entry.name));
    const expired = traces.slice(TRACE_RETENTION).map(({ entry }) => entry.name.slice(0, -5));
    await Promise.all(entries.filter((entry) => expired.some((id) => entry.name === `${id}.json` || entry.name.startsWith(`${id}-`))).map((entry) => rm(path.join(directory, entry.name), { force: true })));
  }
}

export const traceStore = new TraceStore();
