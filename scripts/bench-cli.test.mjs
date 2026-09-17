import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCommands,
  parseCliJson,
  parseRuns,
  selectPageByUrl,
  summarize,
} from "./bench-cli.mjs";

const benchScript = fileURLToPath(new URL("./bench-cli.mjs", import.meta.url));

const fakeBinarySource = `
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[2];
const logFile = process.env.FAKE_LOG;
let previous = [];
try {
  previous = readFileSync(logFile, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
} catch {}
appendFileSync(logFile, JSON.stringify(args) + "\\n");
const invocation = previous.filter((entry) => entry[2] === command).length + 1;
const fail = (message) => { console.error(message); process.exitCode = 3; };

if (process.env.FAKE_MODE === "escape-fail" && command === "press") {
  fail("Escape restoration failed");
} else if (process.env.FAKE_MODE === "target-missing" && command !== "pages") {
  fail("TARGET_MISSING: requested page does not exist");
} else if (
  process.env.FAKE_MODE === "isolated-failure" &&
  command === "observe" &&
  !args.includes("--within") &&
  invocation === 1
) {
  fail("transient observe failure");
} else if (command === "pages") {
  console.log(JSON.stringify({ protocolVersion: 2, ok: true, pages: [{ id: "TARGET", url: "https://example.test/inbox" }] }));
} else if (command === "find") {
  console.log(JSON.stringify({ protocolVersion: 2, ok: true, matches: [{ ref: "R" + invocation }] }));
} else {
  console.log(JSON.stringify({ protocolVersion: 2, ok: true, action: command }));
}
`;

function runWithFakeBinary(t, { mode, findName = "" }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dev-browser-bench-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakeBinary = path.join(directory, "fake dev-browser.mjs");
  const logFile = path.join(directory, "calls.jsonl");
  writeFileSync(fakeBinary, fakeBinarySource);
  writeFileSync(logFile, "");

  const result = spawnSync(process.execPath, [benchScript, "--runs", "2"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CONNECT: "http://127.0.0.1:9223",
      DEV_BROWSER_BIN: fakeBinary,
      FAKE_LOG: logFile,
      FAKE_MODE: mode,
      FIND_NAME: findName,
      PAGE: "TARGET",
    },
  });
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  return { ...result, calls };
}

test("parseRuns defaults to five and accepts one bounded positive integer", () => {
  assert.equal(parseRuns([]), 5);
  assert.equal(parseRuns(["--runs", "1"]), 1);
  assert.equal(parseRuns(["--runs", "100"]), 100);
});

test("parseRuns rejects missing, malformed, repeated, unknown, and excessive values", () => {
  for (const argv of [
    ["--runs"],
    ["--runs", "0"],
    ["--runs", "-1"],
    ["--runs", "1.5"],
    ["--runs", "2x"],
    ["--runs", "101"],
    ["--runs", "2", "--runs", "3"],
    ["--other", "2"],
  ]) {
    assert.throws(() => parseRuns(argv), /--runs|Unknown argument/);
  }
});

test("summarize reports the median, p25-p75 dispersion, maximum, and median bytes", () => {
  assert.deepEqual(
    summarize([
      { ms: 50, bytes: 500, code: 0 },
      { ms: 10, bytes: 100, code: 0 },
      { ms: 40, bytes: 400, code: 3 },
      { ms: 20, bytes: 200, code: 0 },
      { ms: 30, bytes: 300, code: 0 },
    ]),
    {
      medianMs: 30,
      p25Ms: 20,
      p75Ms: 40,
      maxMs: 50,
      medianBytes: 300,
      failures: 1,
    }
  );
});

test("summarize averages the middle pair for an even sample count", () => {
  const result = summarize([
    { ms: 10, bytes: 1, code: 0 },
    { ms: 20, bytes: 3, code: 0 },
  ]);
  assert.equal(result.medianMs, 15);
  assert.equal(result.medianBytes, 2);
});

test("buildCommands contains only the allowed live actions in safety order", () => {
  assert.deepEqual(buildCommands({ page: "target id", findName: "Inbox row", ref: "F0:R7" }), [
    { key: "pages", args: ["pages"] },
    { key: "observe", args: ["observe", "--page", "target id"] },
    {
      key: "observe-main",
      args: ["observe", "--page", "target id", "--within", "main"],
    },
    {
      key: "find",
      args: [
        "find",
        "--page",
        "target id",
        "--role",
        "button",
        "--name-mode",
        "contains",
        "--name",
        "Inbox row",
        "--within",
        "main",
      ],
    },
    { key: "text-main", args: ["text", "--page", "target id", "--within", "main"] },
    { key: "shot", args: ["shot", "--page", "target id"] },
    { key: "click", args: ["click", "--page", "target id", "--ref", "F0:R7"] },
    {
      key: "press-escape",
      args: ["press", "--page", "target id", "--ref", "F0:R7", "--key", "Escape"],
    },
    {
      key: "scroll",
      args: ["scroll", "--page", "target id", "--direction", "down", "--pages", "1"],
    },
  ]);
});

test("buildCommands omits find and trusted input when no FIND_NAME is supplied", () => {
  const commands = buildCommands({ page: "TARGET" });
  assert.deepEqual(
    commands.map(({ key }) => key),
    ["pages", "observe", "observe-main", "text-main", "shot", "scroll"]
  );
});

test("parseCliJson supports current and nested protocol envelopes", () => {
  assert.deepEqual(parseCliJson('{"protocolVersion":2,"ok":true,"pages":[{"id":"A"}]}'), {
    protocolVersion: 2,
    ok: true,
    pages: [{ id: "A" }],
  });
  assert.deepEqual(parseCliJson('{"result":{"matches":[{"ref":"R2"}]}}'), {
    matches: [{ ref: "R2" }],
  });
  assert.throws(() => parseCliJson("not json"), /Invalid JSON/);
});

test("selectPageByUrl resolves a unique target by URL and never by list position", () => {
  const pages = [
    { id: "A", url: "https://example.test/other", name: null },
    { id: "B", url: "https://example.test/inbox", name: "inbox" },
  ];
  assert.equal(selectPageByUrl({ pages }, "/inbox"), "B");
  assert.throws(() => selectPageByUrl({ pages }, "/missing"), /No page URL matches/);
  assert.throws(
    () => selectPageByUrl({ pages: [...pages, { id: "C", url: "https://other.test/inbox" }] }, "/inbox"),
    /Multiple page URLs match/
  );
});

test("a failed Escape aborts before a second click and uses the last successful find ref", (t) => {
  const result = runWithFakeBinary(t, { mode: "escape-fail", findName: "Inbox row" });
  const clicks = result.calls.filter((args) => args[2] === "click");
  const presses = result.calls.filter((args) => args[2] === "press");

  assert.equal(result.status, 1, result.stderr);
  assert.equal(clicks.length, 1);
  assert.equal(presses.length, 1);
  assert.equal(clicks[0][clicks[0].indexOf("--ref") + 1], "R2");
  assert.equal(result.calls.some((args) => args[2] === "scroll"), false);
  assert.match(result.stdout, /press --page TARGET --ref R2 --key Escape/);
  assert.match(result.stderr, /press-escape: 1\/2 failed/);
});

test("an isolated failed sample is reported but keeps a valid benchmark successful", (t) => {
  const result = runWithFakeBinary(t, { mode: "isolated-failure" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /failures\/2/);
  assert.match(result.stderr, /observe: 1\/2 failed/);
});

test("a targeted command with no successful samples makes the benchmark fail", (t) => {
  const result = runWithFakeBinary(t, { mode: "target-missing" });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\| observe --page TARGET \|/);
  assert.match(result.stderr, /TARGET_MISSING/);
  assert.match(result.stderr, /no successful samples/);
});
