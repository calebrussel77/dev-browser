// Reference-safe PowerShell workflow:
//   1. BENCH=1, BENCH_OUT=docs/perf/local.md, DEBUG unset: run the latency baseline.
//   2. BENCH=1, DEBUG=pw:protocol, BENCH_CDP_OUT=docs/perf/local.cdp.md: run the CDP pass.
//   3. node scripts/count-cdp.mjs cdp.log docs/perf/local.md
// The final command changes only the CDP columns in the latency baseline.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function looksLikeUtf16Le(buffer) {
  if (buffer.length < 4) return false;
  const pairs = Math.floor(Math.min(buffer.length, 512) / 2);
  let zeroHighBytes = 0;
  for (let index = 1; index < pairs * 2; index += 2) {
    if (buffer[index] === 0) zeroHighBytes += 1;
  }
  return zeroHighBytes / pairs > 0.3;
}

export function decodeProtocolLog(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString(looksLikeUtf16Le(buffer) ? "utf16le" : "utf8");
}

export function parseProtocolLog(text) {
  const counts = new Map();
  let currentStep = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = /@@MARK (.+) (START|END)\s*$/.exec(trimmed);
    if (marker) {
      currentStep = null;
      if (marker[2] === "START") {
        currentStep = marker[1];
        if (!counts.has(currentStep)) {
          counts.set(currentStep, { messages: 0, methods: new Map() });
        }
      }
      continue;
    }

    // A malformed marker is still an attribution boundary. This prevents an
    // incomplete failed-step marker from leaking traffic into a later step.
    if (trimmed.includes("@@MARK")) {
      currentStep = null;
      continue;
    }

    if (!currentStep || !line.includes("SEND ►")) continue;
    const entry = counts.get(currentStep);
    entry.messages += 1;
    const method = /"method":"([^"]+)"/.exec(line)?.[1];
    if (method) entry.methods.set(method, (entry.methods.get(method) ?? 0) + 1);
  }

  if (counts.size === 0) {
    throw new Error("No usable @@MARK <step> START markers found in the protocol log");
  }
  return counts;
}

export function topMethods(entry) {
  return [...entry.methods.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([method, count]) => `${method}×${count}`)
    .join(", ");
}

export function renderCounts(counts) {
  return [
    "| step | CDP messages | top methods |",
    "|---|---:|---|",
    ...[...counts.entries()].map(
      ([step, entry]) =>
        `| ${step.replaceAll("|", "/")} | ${entry.messages} | ${topMethods(entry)} |`
    ),
  ].join("\n");
}

export function mergeCdpCounts(markdown, counts, source = "benchmark Markdown") {
  const benchmarkLines = markdown.trimEnd().split(/\r?\n/);
  const header =
    benchmarkLines[0]
      ?.split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()) ?? [];
  const stepIndex = header.indexOf("step");
  const messagesIndex = header.indexOf("CDP messages");
  const methodsIndex = header.indexOf("top CDP methods");
  if (stepIndex < 0 || messagesIndex < 0 || methodsIndex < 0) {
    throw new Error(`Cannot merge CDP counts: ${source} is not a bench-actions table`);
  }

  const mergedSteps = new Set();
  const merged = benchmarkLines.map((line, index) => {
    if (index < 2 || !line.startsWith("|")) return line;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const step = cells[stepIndex];
    const entry = counts.get(step);
    cells[messagesIndex] = entry ? String(entry.messages) : "n/a";
    cells[methodsIndex] = entry ? topMethods(entry) : "";
    if (entry) mergedSteps.add(step);
    return `| ${cells.join(" | ")} |`;
  });

  const missingSteps = [...counts.keys()].filter((step) => !mergedSteps.has(step));
  if (missingSteps.length > 0) {
    throw new Error(
      `Cannot merge CDP counts: ${source} is missing step(s): ${missingSteps.join(", ")}`
    );
  }
  return `${merged.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [logFile, markdownArgument] = argv;
  if (!logFile) {
    throw new Error("Usage: node scripts/count-cdp.mjs <cdp.log> [latency-baseline.md]");
  }

  const counts = parseProtocolLog(decodeProtocolLog(readFileSync(logFile)));
  console.log(renderCounts(counts));

  const markdownFile = markdownArgument ?? env.BENCH_OUT;
  if (!markdownFile) return;
  const resolvedMarkdownFile = path.resolve(markdownFile);
  const original = readFileSync(resolvedMarkdownFile, "utf8");
  const merged = mergeCdpCounts(original, counts, resolvedMarkdownFile);
  writeFileSync(resolvedMarkdownFile, merged);
  console.error(`Merged CDP counts into ${resolvedMarkdownFile}`);
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryPoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
