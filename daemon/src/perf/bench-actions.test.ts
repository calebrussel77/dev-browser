// Reference-safe PowerShell workflow:
//   1. $env:BENCH="1"; $env:BENCH_OUT="../docs/perf/local.md"; Remove-Item Env:DEBUG -ErrorAction SilentlyContinue; pnpm bench
//   2. $env:DEBUG="pw:protocol"; $env:BENCH_CDP_OUT="../docs/perf/local.cdp.md"; pnpm bench 2> ../cdp.log
//   3. node ../scripts/count-cdp.mjs ../cdp.log ../docs/perf/local.md
// A protocol-debug run never writes BENCH_OUT. BENCH_CDP_OUT is optional and
// must differ from BENCH_OUT, so the latency reference survives the second run.
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { it } from "vitest";

import { heavyPage } from "./heavy-page.js";

type ExecuteInteractiveAction = typeof import("../interactive-actions.js").executeInteractiveAction;
type InteractiveResult = Awaited<ReturnType<ExecuteInteractiveAction>>;
type InteractiveRequest = Parameters<ExecuteInteractiveAction>[1];

const browserName = "bench";
const pageName = "fixture";
const defaultObserveAction = {
  kind: "observe" as const,
  full: false,
  delta: false,
  track: "default",
  maxNodes: 100,
  maxChars: 12_000,
  depth: 12,
  breadth: 50,
  textOnly: false,
};

interface BenchmarkRow {
  step: string;
  status: string;
  latencyMs: number;
  prettyBytes: number;
  compactBytes: number;
  estimatedTokens: number;
}

type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

const rows: BenchmarkRow[] = [];
const failures: string[] = [];

function markdownCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("|", "/");
}

function benchmarkOutputPath(): string | undefined {
  const protocolDebug = /(?:^|[,\s])pw:protocol(?:$|[,\s])/.test(process.env.DEBUG ?? "");
  if (!protocolDebug) return process.env.BENCH_OUT;
  if (!process.env.BENCH_CDP_OUT) return undefined;

  const instrumented = path.resolve(process.env.BENCH_CDP_OUT);
  const reference = process.env.BENCH_OUT ? path.resolve(process.env.BENCH_OUT) : undefined;
  const sameOutput =
    reference !== undefined &&
    (process.platform === "win32"
      ? instrumented.toLowerCase() === reference.toLowerCase()
      : instrumented === reference);
  if (sameOutput) {
    throw new Error("BENCH_CDP_OUT must differ from BENCH_OUT to preserve the latency baseline");
  }
  return process.env.BENCH_CDP_OUT;
}

function writeBenchmark(): void {
  const configuredOutput = benchmarkOutputPath();
  if (!configuredOutput) return;

  const outputPath = path.resolve(configuredOutput);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    "| step | status | latency ms | pretty bytes | compact bytes | ~tokens | CDP messages | top CDP methods |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...rows.map(
      (row) =>
        `| ${markdownCell(row.step)} | ${markdownCell(row.status)} | ${row.latencyMs} | ${row.prettyBytes} | ${row.compactBytes} | ${row.estimatedTokens} | pending | pending |`
    ),
  ];
  writeFileSync(outputPath, `${lines.join("\n")}\n`);
}

function mark(step: string, phase: "START" | "END"): void {
  process.stderr.write(`@@MARK ${step} ${phase}\n`);
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: string }).code;
  return code ? `${code}: ${error.message}` : error.message;
}

async function timed<TOutput, TValue = TOutput>(
  step: string,
  operation: () => Promise<TOutput>,
  select: (output: TOutput) => TValue = (output) => output as unknown as TValue
): Promise<StepResult<TValue>> {
  mark(step, "START");
  const startedAt = performance.now();
  let output: TOutput | undefined;
  let value: TValue | undefined;
  let status = "ok";

  try {
    output = await operation();
    value = select(output);
  } catch (error) {
    status = `failed: ${errorSummary(error)}`;
    failures.push(`${step}: ${errorSummary(error)}`);
  } finally {
    const latencyMs = Math.round(performance.now() - startedAt);
    mark(step, "END");
    const pretty = output === undefined ? "" : JSON.stringify(output, null, 2);
    const compact = output === undefined ? "" : JSON.stringify(output);
    rows.push({
      step,
      status,
      latencyMs,
      prettyBytes: Buffer.byteLength(pretty),
      compactBytes: Buffer.byteLength(compact),
      estimatedTokens: Math.round(pretty.length / 4),
    });
    writeBenchmark();
  }

  return status === "ok"
    ? { ok: true, value: value as TValue }
    : { ok: false, error: status.slice("failed: ".length) };
}

function skipped<T>(step: string, reason: string): StepResult<T> {
  mark(step, "START");
  mark(step, "END");
  const error = `skipped: ${reason}`;
  rows.push({
    step,
    status: error,
    latencyMs: 0,
    prettyBytes: 0,
    compactBytes: 0,
    estimatedTokens: 0,
  });
  writeBenchmark();
  return { ok: false, error };
}

async function dependentTimed<TDependency, T>(
  step: string,
  prerequisite: StepResult<TDependency>,
  operation: (value: TDependency) => Promise<T>
): Promise<StepResult<T>> {
  if (!prerequisite.ok) return skipped(step, `prerequisite failed (${prerequisite.error})`);
  return timed(step, () => operation(prerequisite.value));
}

function request(
  id: string,
  action: InteractiveRequest["action"],
  extra: Partial<InteractiveRequest> = {}
): InteractiveRequest {
  return {
    id,
    type: "interactive",
    protocolVersion: 2,
    browser: browserName,
    page: pageName,
    timeoutMs: 10_000,
    action,
    ...extra,
  };
}

function firstMatch(result: InteractiveResult, step: string): { ref: string; stateId?: string } {
  const match = result.matches?.[0];
  if (!match) throw new Error(`${step} did not return a match`);
  return { ref: match.ref, stateId: result.stateId };
}

it.skipIf(process.env.BENCH !== "1")(
  "bench interactive actions",
  async () => {
    rows.length = 0;
    failures.length = 0;
    writeBenchmark();

    const benchmarkStartedAt = performance.now();
    const [
      { chromium },
      { resolveActionTarget },
      { BrowserManager },
      { executeInteractiveAction },
      { collectLiveSnapshot },
      { collectPageState },
      { runScript },
      { startAgentReliabilityFixture },
      { resolveDevBrowserTempPath },
    ] = await Promise.all([
      import("playwright"),
      import("../actionability.js"),
      import("../browser-manager.js"),
      import("../interactive-actions.js"),
      import("../live-snapshot.js"),
      import("../perception/collector.js"),
      import("../sandbox/script-runner-quickjs.js"),
      import("../test-fixtures/agent-reliability-fixture.js"),
      import("../temp-files.js"),
    ]);
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-bench-"));
    const artifactPrefix = path.posix.join("bench", path.basename(root));
    const artifactDirectory = await resolveDevBrowserTempPath(artifactPrefix);
    const executablePath = process.env.CHROME_EXE;
    const manager = new BrowserManager(
      path.join(root, "browsers"),
      executablePath
        ? {
            launchPersistentContext: ((directory: string, options: Record<string, unknown>) =>
              chromium.launchPersistentContext(directory, {
                ...options,
                executablePath,
              })) as typeof chromium.launchPersistentContext,
          }
        : {}
    );
    let fixture: Awaited<ReturnType<typeof startAgentReliabilityFixture>> | undefined;
    let primaryError: unknown;

    try {
      await manager.ensureBrowser(browserName, { headless: true });
      fixture = await startAgentReliabilityFixture();
      const page = await manager.getPage(browserName, pageName);
      await page.goto(fixture.mainUrl, { waitUntil: "domcontentloaded" });

      await timed("fixture: observe", () =>
        executeInteractiveAction(manager, request("fixture-observe", defaultObserveAction))
      );

      const fixtureConnect = await timed(
        "fixture: find button Connect within main",
        () =>
          executeInteractiveAction(
            manager,
            request("fixture-find-connect", {
              kind: "find",
              role: "button",
              name: "Connect",
              nameMode: "exact",
              within: "main",
              scope: "document",
              states: [],
              limit: 5,
            })
          ),
        (result) => firstMatch(result, "fixture find")
      );

      await dependentTimed("fixture: click --ref", fixtureConnect, (target) =>
        executeInteractiveAction(
          manager,
          request("fixture-click", {
            kind: "click",
            ref: target.ref,
            fromState: target.stateId,
            method: "mouse",
            retry: "never",
          })
        )
      );
      await dependentTimed("fixture: click --ref --shot", fixtureConnect, (target) =>
        executeInteractiveAction(
          manager,
          request(
            "fixture-click-shot",
            { kind: "click", ref: target.ref, method: "mouse", retry: "never" },
            {
              shot: path.posix.join(artifactPrefix, "bench-click.png"),
              shotTimeoutMs: 8_000,
            }
          )
        )
      );
      await dependentTimed("fixture: click --ref --wait-text", fixtureConnect, (target) =>
        executeInteractiveAction(
          manager,
          request("fixture-click-wait-text", {
            kind: "click",
            ref: target.ref,
            method: "mouse",
            retry: "never",
            waitForText: "Agent reliability fixture",
          })
        )
      );

      const fixtureTextbox = await timed(
        "setup: find fixture textbox",
        () =>
          executeInteractiveAction(
            manager,
            request("fixture-find-textbox", {
              kind: "find",
              role: "textbox",
              scope: "document",
              states: [],
              limit: 5,
            })
          ),
        (result) => firstMatch(result, "fixture textbox find")
      );
      await dependentTimed("fixture: type --ref", fixtureTextbox, (target) =>
        executeInteractiveAction(
          manager,
          request("fixture-type", {
            kind: "type",
            ref: target.ref,
            text: "hello world!",
            clear: true,
            delayMs: 0,
          })
        )
      );
      await timed("fixture: shot", () =>
        executeInteractiveAction(
          manager,
          request(
            "fixture-shot",
            { kind: "shot" },
            {
              shot: path.posix.join(artifactPrefix, "bench-shot.png"),
              shotTimeoutMs: 8_000,
            }
          )
        )
      );
      await timed("fixture: navigate", () =>
        executeInteractiveAction(
          manager,
          request("fixture-navigate", { kind: "navigate", url: fixture!.mainUrl })
        )
      );
      await timed("fixture: pages", () =>
        executeInteractiveAction(manager, request("fixture-pages", { kind: "pages" }))
      );
      await timed("raw: collectPageState", () => collectPageState(page, {}));
      await timed("raw: collectLiveSnapshot", () => collectLiveSnapshot(page));

      const resolveTarget = await timed(
        "setup: find resolveActionTarget target",
        () =>
          executeInteractiveAction(
            manager,
            request("fixture-find-connect-resolve", {
              kind: "find",
              role: "button",
              name: "Connect",
              nameMode: "exact",
              within: "main",
              scope: "document",
              states: [],
              limit: 5,
            })
          ),
        (result) => firstMatch(result, "fixture resolve find")
      );
      await dependentTimed("raw: resolveActionTarget", resolveTarget, async (target) => {
        const resolved = await resolveActionTarget(page, target.ref, {
          timeoutMs: 10_000,
          scroll: true,
          hitTest: true,
          applicability: "pointer",
          pageName,
        });
        await resolved.cleanup();
        return {
          originalRef: resolved.originalRef,
          actualRef: resolved.actualRef,
          resolvedBy: resolved.resolvedBy,
          box: resolved.box,
        };
      });

      const script = `const page = await browser.getPage("${pageName}"); console.log(await page.title());`;
      await timed("script: trivial (cold)", () =>
        runScript(
          script,
          manager,
          browserName,
          { onStdout: () => undefined, onStderr: () => undefined },
          { timeout: 10_000 }
        )
      );
      await timed("script: trivial (warm)", () =>
        runScript(
          script,
          manager,
          browserName,
          { onStdout: () => undefined, onStderr: () => undefined },
          { timeout: 10_000 }
        )
      );

      await page.setContent(heavyPage(), { waitUntil: "domcontentloaded" });
      await timed("heavy: observe", () =>
        executeInteractiveAction(manager, request("heavy-observe", defaultObserveAction))
      );
      await timed("heavy: observe --elements", () =>
        executeInteractiveAction(
          manager,
          request("heavy-observe-elements", defaultObserveAction, { elements: true })
        )
      );
      await timed("heavy: observe --verbose", () =>
        executeInteractiveAction(
          manager,
          request("heavy-observe-verbose", defaultObserveAction, { verbose: true })
        )
      );
      await timed("heavy: observe --within main --max-nodes 300", () =>
        executeInteractiveAction(
          manager,
          request("heavy-observe-main", {
            ...defaultObserveAction,
            maxNodes: 300,
            within: "main",
          })
        )
      );
      await timed("heavy: observe --delta", () =>
        executeInteractiveAction(
          manager,
          request("heavy-observe-delta", { ...defaultObserveAction, delta: true })
        )
      );

      const heavyButton = await timed(
        "heavy: find More actions 77",
        () =>
          executeInteractiveAction(
            manager,
            request("heavy-find-actions", {
              kind: "find",
              role: "button",
              name: "More actions 77",
              nameMode: "exact",
              within: "main",
              scope: "document",
              states: [],
              limit: 5,
            })
          ),
        (result) => firstMatch(result, "heavy find")
      );
      await dependentTimed("heavy: click --ref", heavyButton, (target) =>
        executeInteractiveAction(
          manager,
          request("heavy-click", {
            kind: "click",
            ref: target.ref,
            fromState: target.stateId,
            method: "mouse",
            retry: "never",
          })
        )
      );
      const note = await timed(
        "setup: find heavy note",
        () =>
          executeInteractiveAction(
            manager,
            request("heavy-find-note", {
              kind: "find",
              role: "textbox",
              name: "Note",
              nameMode: "contains",
              scope: "document",
              states: [],
              limit: 5,
            })
          ),
        (result) => firstMatch(result, "heavy note find")
      );
      await dependentTimed("heavy: type --ref 40 chars", note, (target) =>
        executeInteractiveAction(
          manager,
          request("heavy-type", {
            kind: "type",
            ref: target.ref,
            text: "Bonjour, ravi de vous rencontrer hier !",
            clear: true,
            delayMs: 0,
          })
        )
      );
      await timed("heavy: raw collectPageState", () => collectPageState(page, {}));
      await timed("heavy: raw collectLiveSnapshot", () => collectLiveSnapshot(page));
      await timed("heavy: text --within main", () =>
        executeInteractiveAction(
          manager,
          request("heavy-text", { kind: "text", within: "main", maxChars: 20_000 })
        )
      );
      await timed("heavy: assert --within main", () =>
        executeInteractiveAction(
          manager,
          request("heavy-assert", {
            kind: "assert",
            within: "main",
            text: "People you may know",
            match: "contains",
          })
        )
      );
      await timed("heavy: scroll down", () =>
        executeInteractiveAction(
          manager,
          request("heavy-scroll", { kind: "scroll", direction: "down", pages: 1 })
        )
      );
      await dependentTimed("heavy: press Tab", heavyButton, (target) =>
        executeInteractiveAction(
          manager,
          request("heavy-press", { kind: "press", ref: target.ref, key: "Tab" })
        )
      );
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanup = await Promise.allSettled([
        fixture?.close() ?? Promise.resolve(),
        manager.stopAll(),
      ]);
      for (const [index, result] of cleanup.entries()) {
        if (result.status === "rejected") {
          const target = index === 0 ? "fixture" : "browser manager";
          failures.push(`${target} cleanup: ${errorSummary(result.reason)}`);
        }
      }
      const removals = await Promise.allSettled(
        [artifactDirectory, root].map((directory) =>
          rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 6,
            retryDelay: 100,
          })
        )
      );
      for (const [index, result] of removals.entries()) {
        if (result.status === "rejected") {
          const target = index === 0 ? "screenshot directory" : "browser temp directory";
          failures.push(`${target} cleanup: ${errorSummary(result.reason)}`);
        }
      }
    }

    const elapsedMs = Math.round(performance.now() - benchmarkStartedAt);
    if (elapsedMs >= 60_000) failures.push(`benchmark exceeded 60 seconds (${elapsedMs} ms)`);
    if (primaryError || failures.length > 0) {
      const causes = [
        ...(primaryError ? [primaryError] : []),
        ...failures.map((failure) => new Error(failure)),
      ];
      throw new AggregateError(
        causes,
        `Benchmark failures:\n${[
          ...(primaryError ? [`primary: ${errorSummary(primaryError)}`] : []),
          ...failures,
        ].join("\n")}`
      );
    }
  },
  60_000
);
