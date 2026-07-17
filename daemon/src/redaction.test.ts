import { describe, expect, it } from "vitest";

import { redactSensitive } from "./redaction.js";
import { AgentProtocolError } from "./agent-protocol.js";

describe("global bounded secret redaction", () => {
  it("redacts the secret corpus and cross-field URL leaks while preserving useful context", () => {
    const expected = "Naminsita Bakayoko";
    const token = "opaque_confirmation_token_1234567890";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno";
    const urlSecret = "mixed Case+/secret";
    const value = {
      ok: true,
      confirmationToken: token,
      expectedText: expected,
      headers: { Authorization: `Bearer ${jwt}`, Cookie: "sid=cookie-secret", "Set-Cookie": "sid=set-cookie-secret", "Proxy-Authorization": "Basic proxy-secret" },
      url: `https://user:pass@example.test/callback?ToKeN=${encodeURIComponent(urlSecret)}&token=duplicate&token=again#access_token=fragment-secret`,
      title: `Callback ${urlSecret} ${jwt}`,
      requestBody: `password=body-secret&safe=value`,
      upload: { fileContents: "file-secret", path: "C:\\Users\\Caleb\\private\\secret.txt" },
      console: `authorization: Bearer ${jwt}`,
    };
    const redacted = redactSensitive(value);
    const serialized = JSON.stringify(redacted);
    for (const secret of [token, expected, jwt, urlSecret, "duplicate", "again", "fragment-secret", "cookie-secret", "set-cookie-secret", "proxy-secret", "body-secret", "file-secret", "Caleb"])
      expect(serialized).not.toContain(secret);
    expect(redacted).toMatchObject({ ok: true, confirmationToken: "[redacted]", expectedText: "[redacted]" });
    expect(serialized).toContain("example.test");
  });

  it("never throws on malformed URLs, cyclic values, oversized structures, or encoded secrets", () => {
    const cyclic: any = { url: "https://[broken/%E0%A4%A?token=bad-secret", message: "bad-secret", values: [] };
    cyclic.self = cyclic;
    cyclic.values = Array.from({ length: 6_000 }, (_, index) => ({ index, authorization: `Bearer secret-${index}` }));
    expect(() => redactSensitive(cyclic)).not.toThrow();
    const serialized = JSON.stringify(redactSensitive(cyclic));
    expect(serialized.length).toBeLessThan(500_000);
    expect(serialized).not.toContain("secret-4999");
    expect(serialized).toContain("[circular]");
  });

  it("redacts copied secrets across equivalent URL encodings", () => {
    const value = {
      url: "https://example.test/callback?token=a+b%2fc",
      title: "Callback a+b%2fc",
      message: "Equivalent a+b%2Fc and decoded a b/c",
    };
    const serialized = JSON.stringify(redactSensitive(value));
    expect(serialized).not.toContain("a+b%2fc");
    expect(serialized).not.toContain("a+b%2Fc");
    expect(serialized).not.toContain("a b/c");
  });

  it("redacts structured header and cookie name/value representations", () => {
    const value = {
      headerMap: { Cookie: "sid=map-cookie", "Set-Cookie": "sid=map-set-cookie" },
      headers: [
        { name: "Cookie", value: "sid=array-cookie" },
        { name: "sEt-CoOkIe", value: "sid=array-set-cookie" },
      ],
      cookies: [{ name: "sid", value: "cookie-object-secret" }],
      title: "map-cookie map-set-cookie array-cookie array-set-cookie cookie-object-secret",
    };
    const serialized = JSON.stringify(redactSensitive(value));
    for (const secret of ["map-cookie", "map-set-cookie", "array-cookie", "array-set-cookie", "cookie-object-secret"])
      expect(serialized).not.toContain(secret);
  });

  it("bounds the secret discovery pass globally", () => {
    let reads = 0;
    const tree = (depth: number): Record<string, unknown> => {
      const value: Record<string, unknown> = {};
      for (let index = 0; index < 13; index += 1) {
        const child = depth === 0 ? "safe" : tree(depth - 1);
        Object.defineProperty(value, `node-${index}`, {
          enumerable: true,
          get() {
            reads += 1;
            return child;
          },
        });
      }
      return value;
    };
    redactSensitive(tree(3));
    expect(reads).toBeLessThanOrEqual(40_100);
  });

  it("fails closed when the secret budget is exhausted", () => {
    const groups = Array.from({ length: 4 }, (_, group) =>
      Array.from({ length: 500 }, (_, index) => ({ token: `secret-value-${group}-${index}` }))
    );
    groups.push([{ token: "overflow-secret", title: "overflow-secret" }] as any);
    const serialized = JSON.stringify(redactSensitive({ groups }));
    expect(serialized).not.toContain("overflow-secret");
  });

  it("does not materialize getters beyond the per-object bound", () => {
    let reads = 0;
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) {
      Object.defineProperty(wide, `field-${index}`, {
        enumerable: true,
        get() { reads += 1; return "safe"; },
      });
    }
    redactSensitive(wide);
    expect(reads).toBeLessThanOrEqual(4_000);
  });

  it("snapshots getters once so values cannot change after discovery", () => {
    let reads = 0;
    const value = {
      get title() {
        reads += 1;
        return reads === 1 ? "safe" : "raw-secret";
      },
    };
    const serialized = JSON.stringify(redactSensitive(value));
    expect(reads).toBe(1);
    expect(serialized).not.toContain("raw-secret");
  });

  it("preserves typed error control fields when discovery fails closed", () => {
    const details = Array.from({ length: 2_001 }, (_, index) => ({ token: `secret-${index}` }));
    const error = new AgentProtocolError("DAEMON_VERSION_MISMATCH", "runtime mismatch", true, { details });
    expect(error.toAgentError()).toMatchObject({
      code: "DAEMON_VERSION_MISMATCH",
      recoverable: true,
    });
  });

  it("reveals only the required confirmation token result path when explicitly allowed", () => {
    const value = { confirmationToken: "opaque_123456789012345678901234567890", message: "opaque_123456789012345678901234567890", expectedText: "recipient-secret" };
    const redacted = redactSensitive(value, { allowConfirmationToken: true }) as any;
    expect(redacted.confirmationToken).toBe(value.confirmationToken);
    expect(redacted.message).toBe("[redacted]");
    expect(redacted.expectedText).toBe("[redacted]");
  });
});
