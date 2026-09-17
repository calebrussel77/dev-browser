import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommands,
  parseCliJson,
  parseRuns,
  selectPageByUrl,
  summarize,
} from "./bench-cli.mjs";

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
