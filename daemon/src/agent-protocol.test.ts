import { describe, expect, it } from "vitest";

import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolError,
  buildInteractiveFailure,
  buildInteractiveSuccess,
  parseAgentError,
  parseInteractiveFailure,
  parseInteractiveSuccess,
  toAgentError,
} from "./agent-protocol.js";

describe("agent protocol v2", () => {
  it("builds and parses a versioned success envelope without losing action fields", () => {
    const envelope = buildInteractiveSuccess({
      requestId: "read-1",
      browser: "daily",
      page: "TARGET",
      action: "read",
      result: { action: "read", page: "TARGET", snapshot: '- button "Save"' },
    });

    expect(AGENT_PROTOCOL_VERSION).toBe(2);
    expect(parseInteractiveSuccess(envelope)).toMatchObject({
      protocolVersion: 2,
      ok: true,
      requestId: "read-1",
      browser: "daily",
      page: "TARGET",
      action: "read",
      snapshot: '- button "Save"',
    });
  });

  it("builds and parses a typed failure envelope", () => {
    const envelope = buildInteractiveFailure({
      requestId: "click-1",
      browser: "daily",
      page: "TARGET",
      action: "click",
      error: new AgentProtocolError("STALE_REF", "R12 is stale", true, {
        details: { ref: "R12" },
        nextCommands: ["dev-browser read --page TARGET"],
      }),
    });

    expect(parseInteractiveFailure(envelope)).toEqual({
      protocolVersion: 2,
      ok: false,
      requestId: "click-1",
      browser: "daily",
      page: "TARGET",
      action: "click",
      error: {
        code: "STALE_REF",
        message: "R12 is stale",
        recoverable: true,
        details: { ref: "R12" },
        nextCommands: ["dev-browser read --page TARGET"],
      },
    });
  });

  it("rejects unbounded recovery commands and unsafe details", () => {
    expect(() =>
      parseAgentError({
        code: "WAIT_TIMEOUT",
        message: "timed out",
        recoverable: true,
        nextCommands: Array.from({ length: 6 }, (_, index) => `command-${index}`),
      })
    ).toThrow();
    expect(() =>
      parseAgentError({
        code: "WAIT_TIMEOUT",
        message: "timed out",
        recoverable: true,
        details: { secret: BigInt(1) },
      })
    ).toThrow();
    expect(() =>
      parseAgentError({
        code: "WAIT_TIMEOUT",
        message: "timed out",
        recoverable: true,
        details: { omittedByJson: undefined },
      })
    ).toThrow();
    expect(() =>
      parseAgentError({
        code: "WAIT_TIMEOUT",
        message: "timed out",
        recoverable: true,
        nextCommands: ["x".repeat(501)],
      })
    ).toThrow();
  });

  it("bounds messages from untyped runtime errors", () => {
    const error = toAgentError(new Error("x".repeat(5_000)));

    expect(error.code).toBe("RENDERER_UNRESPONSIVE");
    expect(error.message).toHaveLength(4_000);
  });

  it("stores the redacted error message after cross-field discovery", () => {
    const error = new AgentProtocolError("RENDERER_UNRESPONSIVE", "Failure supersecret", false, {
      details: { token: "supersecret" },
    });
    expect(error.message).toBe("Failure [redacted]");
    expect(JSON.stringify(error.toAgentError())).not.toContain("supersecret");
  });

  it("preserves required envelope controls when a result exceeds discovery bounds", () => {
    const envelope = buildInteractiveSuccess({
      requestId: "observe-large",
      browser: "default",
      page: "main",
      action: "observe",
      result: {
        entries: Array.from({ length: 2_001 }, (_, index) => ({ token: `secret-${index}` })),
      },
    });
    expect(envelope).toMatchObject({ protocolVersion: 2, ok: true, action: "observe" });
  });
});
