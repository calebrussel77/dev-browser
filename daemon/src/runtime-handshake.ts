import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DAEMON_VERSION = "0.1.0";
export const DAEMON_PROTOCOL_VERSION = 2;
export const EXPECTED_PLAYWRIGHT_VERSION = "1.61.1";
export const SANDBOX_PROTOCOL_VERSION = 1;

export interface HandshakeClient {
  cliVersion: string;
  cliBuildHash: string;
  embeddedDaemonHash: string;
  expectedDaemonHash: string;
}

interface HandshakeDependencies {
  processHash(): Promise<string>;
  installedVersion(packageName: "playwright" | "quickjs-emscripten"): Promise<string | null>;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function packageVersion(packageName: string): Promise<string | null> {
  const entryPath = process.env.DEV_BROWSER_PROCESS_ENTRY;
  const starts = [entryPath ? path.dirname(entryPath) : undefined, process.cwd()].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  const visited = new Set<string>();
  for (const start of starts) {
    let current = path.resolve(start);
    while (!visited.has(current)) {
      visited.add(current);
      try {
        const packagePath = path.join(current, "node_modules", packageName, "package.json");
        const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
        if (typeof manifest.version === "string") return manifest.version;
      } catch {
        // Continue through ancestors. Package exports need not expose package.json.
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

const defaultDependencies: HandshakeDependencies = {
  processHash: currentProcessHash,
  installedVersion: packageVersion,
};

export async function currentProcessHash(): Promise<string> {
  const entryPath = process.env.DEV_BROWSER_PROCESS_ENTRY ?? fileURLToPath(import.meta.url);
  return sha256(await readFile(entryPath));
}

export async function buildRuntimeHandshake(
  client: HandshakeClient,
  dependencies: HandshakeDependencies = defaultDependencies
) {
  const [processHash, installedPlaywright, quickjsVersion] = await Promise.all([
    dependencies.processHash(),
    dependencies.installedVersion("playwright"),
    dependencies.installedVersion("quickjs-emscripten"),
  ]);

  return {
    client,
    daemon: {
      version: DAEMON_VERSION,
      processHash,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    },
    playwright: {
      expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
      installedVersion: installedPlaywright,
    },
    quickjs: {
      packageVersion: quickjsVersion,
      sandboxProtocolVersion: SANDBOX_PROTOCOL_VERSION,
      provenance: "quickjs-emscripten sandbox-client",
    },
  };
}

export class OperationTracker {
  #activeOperations = 0;
  #restartPending = false;

  get activeOperations(): number {
    return this.#activeOperations;
  }

  begin(): () => void {
    if (this.#restartPending) throw new Error("Daemon restart is pending");
    this.#activeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeOperations -= 1;
    };
  }

  reserveIdleRestart(): { ok: boolean; activeOperations: number } {
    if (this.#restartPending || this.#activeOperations !== 0) {
      return { ok: false, activeOperations: this.#activeOperations };
    }
    this.#restartPending = true;
    return { ok: true, activeOperations: 0 };
  }
}
