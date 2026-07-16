import { describe, expect, it } from "vitest";

import { parseRequest } from "./protocol.js";

describe("interactive request protocol", () => {
  it("defaults omitted protocol versions to legacy v1 and accepts v2", () => {
    for (const [protocolVersion, expected] of [
      [undefined, 1],
      [2, 2],
    ] as const) {
      const result = parseRequest(
        JSON.stringify({
          id: `interactive-v${expected}`,
          type: "interactive",
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          action: { kind: "pages" },
        })
      );

      expect(result).toMatchObject({
        success: true,
        request: { protocolVersion: expected },
      });
    }
  });

  it("returns a typed non-recoverable mismatch for unsupported versions", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-v3",
        type: "interactive",
        protocolVersion: 3,
        action: { kind: "pages" },
      })
    );

    expect(result).toMatchObject({
      success: false,
      id: "interactive-v3",
      agentError: {
        code: "PROTOCOL_VERSION_MISMATCH",
        recoverable: false,
        nextCommands: ["dev-browser schema --json"],
      },
    });
  });

  it("bounds mismatch errors for oversized invalid versions", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-oversized-version",
        type: "interactive",
        protocolVersion: "x".repeat(20_000),
        action: { kind: "pages" },
      })
    );

    expect(result).toMatchObject({
      success: false,
      id: "interactive-oversized-version",
      agentError: {
        code: "PROTOCOL_VERSION_MISMATCH",
        recoverable: false,
      },
    });
  });

  it("parses a read request with browser connection options", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-read",
        type: "interactive",
        browser: "daily",
        connect: "auto",
        timeoutMs: 15_000,
        page: "TARGET123",
        shot: "before.png",
        action: { kind: "read", limit: 80, depth: 12 },
      })
    );

    expect(result).toEqual({
      success: true,
      request: expect.objectContaining({
        action: { kind: "read", limit: 80, depth: 12 },
        browser: "daily",
        page: "TARGET123",
        shot: "before.png",
        type: "interactive",
      }),
    });
  });

  it("parses observe modes, tracking, and every hard budget", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-observe",
        type: "interactive",
        protocolVersion: 2,
        page: "TARGET123",
        action: {
          kind: "observe",
          full: true,
          delta: true,
          track: "checkout",
          maxNodes: 999,
          maxChars: 99_999,
          depth: 49,
          breadth: 499,
        },
      })
    );

    expect(result).toMatchObject({
      success: true,
      request: {
        protocolVersion: 2,
        action: {
          kind: "observe",
          full: true,
          delta: true,
          track: "checkout",
          maxNodes: 999,
          maxChars: 99_999,
          depth: 49,
          breadth: 499,
        },
      },
    });
  });

  it("rejects malformed continuation syntax at the protocol boundary", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-observe-invalid-cursor",
        type: "interactive",
        protocolVersion: 2,
        action: { kind: "observe", continuation: "bad cursor!" },
      })
    );

    expect(result).toMatchObject({ success: false });
  });

  it("parses trusted mouse and locator clicks by ref", () => {
    for (const method of ["mouse", "locator"] as const) {
      const result = parseRequest(
        JSON.stringify({
          id: `interactive-click-${method}`,
          type: "interactive",
          page: "main",
          action: {
            kind: "click",
            ref: "R12",
            method,
            expectText: "Naminsita Bakayoko",
            waitForText: "Invitation sent",
          },
        })
      );

      expect(result).toMatchObject({
        success: true,
        request: {
          action: { kind: "click", ref: "R12", method, waitForText: "Invitation sent" },
        },
      });
    }
  });

  it("parses a coordinate click", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-click-xy",
        type: "interactive",
        page: "main",
        action: { kind: "click", x: 901, y: 631, method: "mouse" },
      })
    );

    expect(result).toMatchObject({
      success: true,
      request: {
        action: { kind: "click", x: 901, y: 631, method: "mouse" },
      },
    });
  });

  it("parses trusted keyboard typing", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-type",
        type: "interactive",
        page: "main",
        action: { kind: "type", ref: "R13", text: "hello", clear: true, delayMs: 12 },
      })
    );

    expect(result).toMatchObject({
      success: true,
      request: {
        action: { kind: "type", ref: "R13", text: "hello", clear: true, delayMs: 12 },
      },
    });
  });

  it("rejects clicks without a ref or coordinates", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-click-invalid",
        type: "interactive",
        page: "main",
        action: { kind: "click", method: "mouse" },
      })
    );

    expect(result).toMatchObject({ success: false });
  });
});
