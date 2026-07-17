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
const ORPHAN_GRACE_MS = 5 * 60_000;

export function traceSecretsForAction(action: Record<string, unknown>): string[] {
  return [action.expectText, action.text, action.confirmToken]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function traceCapabilityWarnings(browserType: "launched" | "connected" | undefined): string[] {
  return browserType === "connected"
    ? ["External CDP tracing is best-effort; browser-context tracing may be unavailable"]
    : [];
}

export class TraceStore {
  readonly #relativeDirectory: string;
  readonly #activeIds = new Set<string>();
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
    const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    this.#activeIds.add(id);
    return id;
  }

  async artifactPath(id: string, name: "before.png"): Promise<string> {
    if (!TRACE_ID.test(id)) throw new Error("Invalid trace id");
    return resolveDevBrowserTempPath(path.join(this.#relativeDirectory, `${id}-${name}`), {
      createParents: true,
    });
  }

  async save(record: Record<string, unknown>, allocatedId?: string, secrets: string[] = []): Promise<{ id: string; path: string }> {
    const run = async () => {
      const id = allocatedId ?? this.allocateId();
      if (!TRACE_ID.test(id)) throw new Error("Invalid trace id");
      this.#activeIds.add(id);
      try {
        const redacted = redactSensitive({ id, ...record }, { secrets });
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
            }, { secrets }),
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
      } catch (error) {
        await this.removeArtifacts(id).catch(() => undefined);
        throw error;
      } finally {
        this.#activeIds.delete(id);
      }
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

  async removeArtifacts(id: string): Promise<void> {
    if (!TRACE_ID.test(id)) throw new Error("Invalid trace id");
    const directory = await this.#directory();
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(`${id}-`)).map((entry) => rm(path.join(directory, entry.name), { force: true })));
    this.#activeIds.delete(id);
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
    const retained = new Set(traces.slice(0, TRACE_RETENTION).map(({ entry }) => entry.name.slice(0, -5)));
    const expired = new Set(traces.slice(TRACE_RETENTION).map(({ entry }) => entry.name.slice(0, -5)));
    const now = Date.now();
    const removals: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const jsonId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : undefined;
      const artifactId = /^([a-z0-9-]{8,80})-/.exec(entry.name)?.[1];
      if (jsonId && expired.has(jsonId)) removals.push(entry.name);
      else if (artifactId && !retained.has(artifactId) && !this.#activeIds.has(artifactId)) {
        const stats = await lstat(path.join(directory, entry.name));
        if (now - stats.mtimeMs >= ORPHAN_GRACE_MS || expired.has(artifactId)) removals.push(entry.name);
      }
    }
    await Promise.all(removals.map((name) => rm(path.join(directory, name), { force: true })));
  }
}

export const traceStore = new TraceStore();
