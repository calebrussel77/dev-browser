// Count protocol sends between benchmark markers:
//   node scripts/count-cdp.mjs cdp.log
// Merge the counts into BENCH_OUT deterministically:
//   node scripts/count-cdp.mjs cdp.log docs/perf/local.md
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , logFile, markdownArgument] = process.argv;
if (!logFile) {
  console.error("Usage: node scripts/count-cdp.mjs <cdp.log> [benchmark.md]");
  process.exitCode = 1;
} else {
  const counts = new Map();
  let currentStep = null;

  for (const line of readFileSync(logFile, "utf8").split(/\r?\n/)) {
    const marker = /@@MARK (.+) (START|END)\s*$/.exec(line.trim());
    if (marker) {
      // Every marker closes the previous attribution window. A missing END on a
      // failed/crashed step therefore cannot leak messages into the next step.
      currentStep = null;
      if (marker[2] === "START") {
        currentStep = marker[1];
        if (!counts.has(currentStep)) counts.set(currentStep, { messages: 0, methods: new Map() });
      }
      continue;
    }

    if (!currentStep || !line.includes("SEND ►")) continue;
    const entry = counts.get(currentStep);
    entry.messages += 1;
    const method = /"method":"([^"]+)"/.exec(line)?.[1];
    if (method) entry.methods.set(method, (entry.methods.get(method) ?? 0) + 1);
  }

  const topMethods = (entry) =>
    [...entry.methods.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4)
      .map(([method, count]) => `${method}×${count}`)
      .join(", ");

  const output = [
    "| step | CDP messages | top methods |",
    "|---|---:|---|",
    ...[...counts.entries()].map(
      ([step, entry]) =>
        `| ${step.replaceAll("|", "/")} | ${entry.messages} | ${topMethods(entry)} |`
    ),
  ];
  console.log(output.join("\n"));

  const markdownFile = markdownArgument ?? process.env.BENCH_OUT;
  if (markdownFile) {
    const resolvedMarkdownFile = path.resolve(markdownFile);
    const benchmarkLines = readFileSync(resolvedMarkdownFile, "utf8").trimEnd().split(/\r?\n/);
    const header =
      benchmarkLines[0]
        ?.split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()) ?? [];
    const stepIndex = header.indexOf("step");
    const messagesIndex = header.indexOf("CDP messages");
    const methodsIndex = header.indexOf("top CDP methods");
    if (stepIndex < 0 || messagesIndex < 0 || methodsIndex < 0) {
      throw new Error(
        `Cannot merge CDP counts: ${resolvedMarkdownFile} is not a bench-actions table`
      );
    }

    const merged = benchmarkLines.map((line, index) => {
      if (index < 2 || !line.startsWith("|")) return line;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const entry = counts.get(cells[stepIndex]);
      cells[messagesIndex] = entry ? String(entry.messages) : "n/a";
      cells[methodsIndex] = entry ? topMethods(entry) : "";
      return `| ${cells.join(" | ")} |`;
    });
    writeFileSync(resolvedMarkdownFile, `${merged.join("\n")}\n`);
    console.error(`Merged CDP counts into ${resolvedMarkdownFile}`);
  }
}
