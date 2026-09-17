// Live end-to-end benchmark for the dev-browser CLI.
// Usage: node scripts/bench-cli.mjs [--runs N]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_RUNS = 100;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 1_000;

function bounded(value, limit = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value ?? "").replaceAll("\0", "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function parseRuns(argv) {
  if (argv.length === 0) return 5;
  if (argv.length !== 2 || argv[0] !== "--runs") {
    const unknown = argv.find((argument) => argument !== "--runs");
    if (argv[0] !== "--runs") {
      throw new Error(`Unknown argument: ${bounded(unknown ?? argv[0] ?? "<missing>", 120)}`);
    }
    throw new Error("Usage: node scripts/bench-cli.mjs [--runs N]");
  }

  const raw = argv[1];
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("--runs must be a strictly positive integer");
  }
  const runs = Number(raw);
  if (!Number.isSafeInteger(runs) || runs > MAX_RUNS) {
    throw new Error(`--runs must be at most ${MAX_RUNS}`);
  }
  return runs;
}

function median(values) {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("Cannot summarize an empty sample set");
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarize(samples) {
  const milliseconds = samples.map(({ ms }) => ms);
  const bytes = samples.map((sample) => sample.bytes);
  return {
    medianMs: median(milliseconds),
    p25Ms: percentile(milliseconds, 0.25),
    p75Ms: percentile(milliseconds, 0.75),
    maxMs: Math.max(...milliseconds),
    medianBytes: median(bytes),
    failures: samples.filter(({ code }) => code !== 0).length,
  };
}

export function buildCommands({ page, findName = "", ref } = {}) {
  if (typeof page !== "string" || page.length === 0) {
    throw new Error("A non-empty page target is required");
  }

  const commands = [
    { key: "pages", args: ["pages"] },
    { key: "observe", args: ["observe", "--page", page] },
    {
      key: "observe-main",
      args: ["observe", "--page", page, "--within", "main"],
    },
  ];

  if (findName) {
    commands.push({
      key: "find",
      args: [
        "find",
        "--page",
        page,
        "--role",
        "button",
        "--name-mode",
        "contains",
        "--name",
        findName,
        "--within",
        "main",
      ],
    });
  }

  commands.push(
    { key: "text-main", args: ["text", "--page", page, "--within", "main"] },
    { key: "shot", args: ["shot", "--page", page] }
  );

  if (findName && ref) {
    commands.push(
      { key: "click", args: ["click", "--page", page, "--ref", ref] },
      {
        key: "press-escape",
        args: ["press", "--page", page, "--ref", ref, "--key", "Escape"],
      }
    );
  }

  commands.push({
    key: "scroll",
    args: ["scroll", "--page", page, "--direction", "down", "--pages", "1"],
  });
  return commands;
}

export function parseCliJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON from dev-browser: ${bounded(reason, 240)}`);
  }

  for (let depth = 0; depth < 4; depth += 1) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
    if (Object.hasOwn(parsed, "pages") || Object.hasOwn(parsed, "matches")) return parsed;
    if (parsed.result && typeof parsed.result === "object") {
      parsed = parsed.result;
      continue;
    }
    if (parsed.data && typeof parsed.data === "object") {
      parsed = parsed.data;
      continue;
    }
    return parsed;
  }
  return parsed;
}

export function selectPageByUrl(payload, urlFilter) {
  if (typeof urlFilter !== "string" || urlFilter.length === 0) {
    throw new Error("URL_FILTER is required when PAGE is not set");
  }
  const pages = Array.isArray(payload) ? payload : payload?.pages;
  if (!Array.isArray(pages)) {
    throw new Error("The pages response does not contain a pages array");
  }

  const matches = pages.filter(
    (page) => page && typeof page.url === "string" && page.url.includes(urlFilter)
  );
  if (matches.length === 0) {
    throw new Error(`No page URL matches URL_FILTER=${bounded(urlFilter, 160)}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple page URLs match URL_FILTER=${bounded(urlFilter, 160)}; narrow it or set PAGE`
    );
  }
  if (typeof matches[0].id !== "string" || matches[0].id.length === 0) {
    throw new Error("The matching page has no usable target id");
  }
  return matches[0].id;
}

function runProcess(bin, connect, args) {
  const started = performance.now();
  const result = spawnSync(bin, ["--connect", connect, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    shell: false,
    windowsHide: true,
  });
  const ms = performance.now() - started;

  if (result.error) {
    const code = "code" in result.error ? ` (${result.error.code})` : "";
    throw new Error(
      `Unable to run DEV_BROWSER_BIN=${bounded(bin, 160)}${code}: ${bounded(result.error.message)}`
    );
  }

  const stdout = result.stdout ?? "";
  return {
    ms,
    bytes: Buffer.byteLength(stdout, "utf8"),
    code: result.status ?? 1,
    stdout,
    stderr: result.stderr ?? "",
    signal: result.signal,
  };
}

function commandLabel(args) {
  return args
    .map((argument) => (/^[\w./:@=-]+$/.test(argument) ? argument : JSON.stringify(argument)))
    .join(" ");
}

function markdownCell(value) {
  return bounded(value, 500).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function firstFailure(samples) {
  return samples.find(({ code }) => code !== 0);
}

function reportFailures(command, samples, runs) {
  const failure = firstFailure(samples);
  if (!failure) return;
  const detail = (failure.stderr || failure.stdout || failure.signal || "no diagnostic output").trim();
  const count = samples.filter(({ code }) => code !== 0).length;
  console.error(
    `[bench-cli] ${command.key}: ${count}/${runs} failed; first exit=${failure.code}; ${bounded(detail)}`
  );
}

function measure(command, runs, bin, connect) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    samples.push(runProcess(bin, connect, command.args));
  }
  reportFailures(command, samples, runs);
  return { command, samples, stats: summarize(samples) };
}

function extractFoundRef(samples) {
  const successful = samples.filter(({ code }) => code === 0);
  if (successful.length === 0) return undefined;

  let validJson = false;
  let lastError;
  for (const sample of successful) {
    try {
      const payload = parseCliJson(sample.stdout);
      validJson = true;
      const ref = payload?.matches?.find((match) => typeof match?.ref === "string")?.ref;
      if (ref) return ref;
    } catch (error) {
      lastError = error;
    }
  }
  if (!validJson) throw lastError ?? new Error("find returned no usable JSON");
  return undefined;
}

function measureClickAndEscape(click, press, runs, bin, connect) {
  const clickSamples = [];
  const pressSamples = [];

  for (let index = 0; index < runs; index += 1) {
    let clickError;
    try {
      clickSamples.push(runProcess(bin, connect, click.args));
    } catch (error) {
      clickError = error;
    }

    try {
      pressSamples.push(runProcess(bin, connect, press.args));
    } catch (pressError) {
      if (!clickError) throw pressError;
    }
    if (clickError) throw clickError;
  }

  reportFailures(click, clickSamples, runs);
  reportFailures(press, pressSamples, runs);
  return [
    { command: click, samples: clickSamples, stats: summarize(clickSamples) },
    { command: press, samples: pressSamples, stats: summarize(pressSamples) },
  ];
}

function renderTable(rows, runs) {
  console.log(
    `| command | median ms | dispersion ms (p25–p75) | max ms | median stdout bytes | failures/${runs} |`
  );
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const { command, stats } of rows) {
    console.log(
      `| ${markdownCell(commandLabel(command.args))} | ${stats.medianMs.toFixed(1)} | ${stats.p25Ms.toFixed(1)}–${stats.p75Ms.toFixed(1)} | ${stats.maxMs.toFixed(1)} | ${Math.round(stats.medianBytes)} | ${stats.failures} |`
    );
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const runs = parseRuns(argv);
  const bin = env.DEV_BROWSER_BIN || "dev-browser";
  const connect = env.CONNECT || "http://127.0.0.1:9223";
  const findName = env.FIND_NAME || "";
  let page = env.PAGE || "";

  if (!page) {
    if (!env.URL_FILTER) {
      throw new Error("Set PAGE, or set URL_FILTER so pages can select a target by URL");
    }
    const discovery = runProcess(bin, connect, ["pages"]);
    if (discovery.code !== 0) {
      const detail = discovery.stderr || discovery.stdout || discovery.signal || "no diagnostic output";
      throw new Error(`pages discovery failed with exit ${discovery.code}: ${bounded(detail)}`);
    }
    page = selectPageByUrl(parseCliJson(discovery.stdout), env.URL_FILTER);
  }

  const rows = [];
  const initialCommands = buildCommands({ page, findName });
  const scroll = initialCommands.find(({ key }) => key === "scroll");
  let findMeasurement;

  for (const command of initialCommands) {
    if (command.key === "scroll") continue;
    const measurement = measure(command, runs, bin, connect);
    rows.push(measurement);
    if (command.key === "find") findMeasurement = measurement;
  }

  if (findMeasurement) {
    const ref = extractFoundRef(findMeasurement.samples);
    if (ref) {
      const commands = buildCommands({ page, findName, ref });
      const click = commands.find(({ key }) => key === "click");
      const press = commands.find(({ key }) => key === "press-escape");
      rows.push(...measureClickAndEscape(click, press, runs, bin, connect));
    } else {
      console.error("[bench-cli] find returned no ref; click and press Escape were skipped");
    }
  }

  rows.push(measure(scroll, runs, bin, connect));
  renderTable(rows, runs);
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryPoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[bench-cli] ${bounded(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
