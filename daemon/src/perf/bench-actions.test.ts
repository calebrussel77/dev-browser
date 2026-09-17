// PowerShell:
//   $env:BENCH=1; $env:BENCH_OUT="../docs/perf/local.md"; pnpm bench
// CDP pass and deterministic merge:
//   $env:DEBUG="pw:protocol"; pnpm bench 2> ../cdp.log
//   node ../scripts/count-cdp.mjs ../cdp.log ../docs/perf/local.md
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { it } from "vitest";

import { resolveActionTarget } from "../actionability.js";
import { BrowserManager } from "../browser-manager.js";
import { executeInteractiveAction } from "../interactive-actions.js";
import { collectLiveSnapshot } from "../live-snapshot.js";
import { collectPageState } from "../perception/collector.js";
import { startAgentReliabilityFixture } from "../test-fixtures/agent-reliability-fixture.js";
import { heavyPage } from "./heavy-page.js";

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

const rows: BenchmarkRow[] = [];
const failures: string[] = [];

function markdownCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("|", "/");
}

function writeBenchmark(): void {
  if (!process.env.BENCH_OUT) return;

  const outputPath = path.resolve(process.env.BENCH_OUT);
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

async function timed<T>(step: string, operation: () => Promise<T>): Promise<T | undefined> {
  mark(step, "START");
  const startedAt = performance.now();
  let output: T | undefined;
  let status = "ok";

  try {
    output = await operation();
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

  return output;
}

function request(
  id: string,
  action: Parameters<typeof executeInteractiveAction>[1]["action"],
  extra: Partial<Parameters<typeof executeInteractiveAction>[1]> = {}
): Parameters<typeof executeInteractiveAction>[1] {
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

function firstMatch(
  result: Awaited<ReturnType<typeof executeInteractiveAction>> | undefined,
  step: string
): { ref: string; stateId?: string } {
  const match = result?.matches?.[0];
  if (!match) throw new Error(`${step} did not return a match`);
  return { ref: match.ref, stateId: result.stateId };
}

it.skipIf(!process.env.BENCH)(
  "bench interactive actions",
  async () => {
    rows.length = 0;
    failures.length = 0;
    writeBenchmark();

    const benchmarkStartedAt = performance.now();
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-bench-"));
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

    try {
      await manager.ensureBrowser(browserName, { headless: true });
      fixture = await startAgentReliabilityFixture();
      const page = await manager.getPage(browserName, pageName);
      await page.goto(fixture.mainUrl, { waitUntil: "domcontentloaded" });

      const fixtureObserve = await timed("fixture: observe", () =>
        executeInteractiveAction(manager, request("fixture-observe", defaultObserveAction))
      );
      void fixtureObserve;

      const fixtureFind = await timed("fixture: find button Connect within main", () =>
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
        )
      );
      const fixtureConnect = firstMatch(fixtureFind, "fixture find");

      await timed("fixture: click --ref", () =>
        executeInteractiveAction(
          manager,
          request("fixture-click", {
            kind: "click",
            ref: fixtureConnect.ref,
            fromState: fixtureConnect.stateId,
            method: "mouse",
            retry: "never",
          })
        )
      );
      await timed("fixture: click --ref --shot", () =>
        executeInteractiveAction(
          manager,
          request(
            "fixture-click-shot",
            { kind: "click", ref: fixtureConnect.ref, method: "mouse", retry: "never" },
            { shot: "bench-click.png", shotTimeoutMs: 8_000 }
          )
        )
      );
      await timed("fixture: click --ref --wait-text", () =>
        executeInteractiveAction(
          manager,
          request("fixture-click-wait-text", {
            kind: "click",
            ref: fixtureConnect.ref,
            method: "mouse",
            retry: "never",
            waitForText: "Agent reliability fixture",
          })
        )
      );

      const fixtureTextboxResult = await executeInteractiveAction(
        manager,
        request("fixture-find-textbox", {
          kind: "find",
          role: "textbox",
          scope: "document",
          states: [],
          limit: 5,
        })
      );
      const fixtureTextbox = firstMatch(fixtureTextboxResult, "fixture textbox find");
      await timed("fixture: type --ref", () =>
        executeInteractiveAction(
          manager,
          request("fixture-type", {
            kind: "type",
            ref: fixtureTextbox.ref,
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
            { shot: "bench-shot.png", shotTimeoutMs: 8_000 }
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

      const resolveFind = await executeInteractiveAction(
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
      );
      const resolveTarget = firstMatch(resolveFind, "fixture resolve find");
      await timed("raw: resolveActionTarget", async () => {
        const resolved = await resolveActionTarget(page, resolveTarget.ref, {
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

      const { runScript } = await import("../sandbox/script-runner-quickjs.js");
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

      const heavyFind = await timed("heavy: find More actions 77", () =>
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
        )
      );
      const heavyButton = firstMatch(heavyFind, "heavy find");
      await timed("heavy: click --ref", () =>
        executeInteractiveAction(
          manager,
          request("heavy-click", {
            kind: "click",
            ref: heavyButton.ref,
            fromState: heavyButton.stateId,
            method: "mouse",
            retry: "never",
          })
        )
      );
      const noteFind = await executeInteractiveAction(
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
      );
      const note = firstMatch(noteFind, "heavy note find");
      await timed("heavy: type --ref 40 chars", () =>
        executeInteractiveAction(
          manager,
          request("heavy-type", {
            kind: "type",
            ref: note.ref,
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
      await timed("heavy: press Tab", () =>
        executeInteractiveAction(
          manager,
          request("heavy-press", { kind: "press", ref: heavyButton.ref, key: "Tab" })
        )
      );
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
      await rm(root, { recursive: true, force: true });
    }

    const elapsedMs = Math.round(performance.now() - benchmarkStartedAt);
    if (elapsedMs >= 60_000) failures.push(`benchmark exceeded 60 seconds (${elapsedMs} ms)`);
    if (failures.length > 0) throw new Error(`Benchmark failures:\n${failures.join("\n")}`);
  },
  60_000
);
