import assert from "node:assert/strict";
import test from "node:test";

import { decodeProtocolLog, mergeCdpCounts, parseProtocolLog } from "./count-cdp.mjs";

const markdown = `| step | status | latency ms | pretty bytes | compact bytes | ~tokens | CDP messages | top CDP methods |
|---|---|---:|---:|---:|---:|---:|---|
| alpha | ok | 12 | 20 | 10 | 5 | pending | pending |
| beta | ok | 34 | 40 | 30 | 10 | pending | pending |
`;

function utf16LeWithBom(value) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
}

test("decodes UTF-8, UTF-8 BOM, and UTF-16LE PowerShell logs", () => {
  const log =
    '@@MARK alpha START\r\n2026 SEND ► {"method":"Runtime.evaluate"}\r\n@@MARK alpha END\r\n';
  for (const encoded of [
    Buffer.from(log, "utf8"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(log, "utf8")]),
    utf16LeWithBom(log),
    Buffer.from(log, "utf16le"),
  ]) {
    const counts = parseProtocolLog(decodeProtocolLog(encoded));
    assert.equal(counts.get("alpha").messages, 1);
    assert.equal(counts.get("alpha").methods.get("Runtime.evaluate"), 1);
  }
});

test("treats an incomplete marker as an attribution boundary", () => {
  const counts = parseProtocolLog(`@@MARK alpha START
SEND ► {"method":"Runtime.evaluate"}
@@MARK alpha BROKEN
SEND ► {"method":"Page.navigate"}
@@MARK beta START
SEND ► {"method":"Page.captureScreenshot"}
@@MARK beta END
`);
  assert.equal(counts.get("alpha").messages, 1);
  assert.equal(counts.get("beta").messages, 1);
});

test("does not attribute a failed step to the following step when END is missing", () => {
  const counts = parseProtocolLog(`@@MARK failed START
SEND ► {"method":"Runtime.evaluate"}
@@MARK independent START
SEND ► {"method":"Page.navigate"}
@@MARK independent END
SEND ► {"method":"Page.captureScreenshot"}
`);
  assert.equal(counts.get("failed").messages, 1);
  assert.equal(counts.get("independent").messages, 1);
});

test("fails explicitly when the log contains no usable markers", () => {
  assert.throws(
    () => parseProtocolLog('SEND ► {"method":"Runtime.evaluate"}\n@@MARK broken'),
    /No usable @@MARK/
  );
});

test("merges only CDP columns and preserves baseline measurements", () => {
  const counts = parseProtocolLog(`@@MARK alpha START
SEND ► {"method":"Runtime.evaluate"}
@@MARK alpha END
@@MARK beta START
@@MARK beta END
`);
  const merged = mergeCdpCounts(markdown, counts);
  assert.match(merged, /\| alpha \| ok \| 12 \| 20 \| 10 \| 5 \| 1 \| Runtime\.evaluate×1 \|/);
  assert.match(merged, /\| beta \| ok \| 34 \| 40 \| 30 \| 10 \| 0 \|  \|/);
});

test("fails when an instrumented step is absent from the Markdown baseline", () => {
  const counts = parseProtocolLog(`@@MARK missing START
@@MARK missing END
`);
  assert.throws(() => mergeCdpCounts(markdown, counts), /missing step\(s\): missing/);
});
