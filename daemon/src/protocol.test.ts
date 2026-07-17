import { describe, expect, it } from "vitest";

import { parseRequest } from "./protocol.js";

describe("interactive request protocol", () => {
  it("parses every typed wait condition and rejects unsafe or oversized matchers", () => {
    const conditions = [
      { kind: "text", state: "visible", scope: "body", match: "contains", value: "Saved" },
      { kind: "url", match: "glob", value: "**/checkout/*" },
      { kind: "ref", ref: "R7", state: "visible" },
      { kind: "ref", ref: "R8", state: "valueChanged", expected: "done" },
      {
        kind: "ref",
        ref: "R9",
        state: "attributeChanged",
        attribute: "aria-expanded",
        expected: "true",
      },
      { kind: "ref", ref: "R10", state: "stateChanged", attribute: "checked", expected: "true" },
      { kind: "dialog", state: "opened" },
      { kind: "toast", state: "closed" },
      { kind: "popup" },
      { kind: "download" },
      { kind: "fileChooser" },
      { kind: "navigation", state: "document" },
      { kind: "response", match: "contains", value: "/api/", method: "POST", status: 200 },
      { kind: "failedRequest", match: "safe-regex", value: "/api/fail$", method: "GET" },
      { kind: "networkIdle", specialized: true, idleMs: 250 },
    ];
    const parsed = parseRequest(
      JSON.stringify({
        id: "wait-all",
        type: "interactive",
        protocolVersion: 2,
        action: { kind: "click", ref: "R7", wait: { mode: "all", timeoutMs: 1200, conditions } },
      })
    );
    expect(parsed).toMatchObject({
      success: true,
      request: { action: { wait: { mode: "all", conditions } } },
    });

    for (const condition of [
      { kind: "text", state: "visible", scope: "body", match: "safe-regex", value: "(a+)+$" },
      { kind: "url", match: "contains", value: "x".repeat(2001) },
    ]) {
      expect(
        parseRequest(
          JSON.stringify({
            id: "bad-wait",
            type: "interactive",
            action: {
              kind: "click",
              ref: "R1",
              wait: { mode: "any", timeoutMs: 10, conditions: [condition] },
            },
          })
        )
      ).toMatchObject({ success: false });
    }
  });
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
          action: {
            kind: "click",
            ref: "R12",
            method,
            waitForText: "Invitation sent",
            wait: {
              mode: "all",
              conditions: [
                {
                  kind: "text",
                  state: "visible",
                  scope: "body",
                  match: "contains",
                  value: "Invitation sent",
                },
              ],
            },
          },
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

  it("defaults v2 clicks to never and parses every retry policy", () => {
    for (const retry of ["never", "safe", "once"] as const) {
      const result = parseRequest(
        JSON.stringify({
          id: `interactive-click-${retry}`,
          type: "interactive",
          protocolVersion: 2,
          action: { kind: "click", ref: "R12", retry },
        })
      );
      expect(result).toMatchObject({ success: true, request: { action: { retry } } });
    }

    expect(
      parseRequest(
        JSON.stringify({
          id: "interactive-click-default",
          type: "interactive",
          protocolVersion: 2,
          action: { kind: "click", ref: "R12" },
        })
      )
    ).toMatchObject({ success: true, request: { action: { retry: "never" } } });
    expect(
      parseRequest(
        JSON.stringify({
          id: "interactive-click-invalid-retry",
          type: "interactive",
          protocolVersion: 2,
          action: { kind: "click", ref: "R12", retry: "always" },
        })
      )
    ).toMatchObject({ success: false });
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

  it("parses annotation and full-page artifact options", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-annotated",
        type: "interactive",
        protocolVersion: 2,
        page: "main",
        annotate: true,
        fullPage: true,
        shot: "matches.png",
        action: { kind: "find", query: "save", limit: 3 },
      })
    );
    expect(result).toMatchObject({
      success: true,
      request: { annotate: true, fullPage: true, shot: "matches.png" },
    });
  });

  it("parses focused shot options", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "interactive-focused-shot",
        type: "interactive",
        protocolVersion: 2,
        page: "main",
        fullPage: true,
        action: { kind: "shot", ref: "R7", padding: 32 },
      })
    );
    expect(result).toMatchObject({
      success: true,
      request: { fullPage: true, action: { kind: "shot", ref: "R7", padding: 32 } },
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

  it("parses v2 state guards and page sessions", () => {
    const guarded = parseRequest(
      JSON.stringify({
        id: "guarded",
        type: "interactive",
        protocolVersion: 2,
        session: "opaque",
        action: { kind: "click", ref: "R1", fromState: "doc-1:2", strictState: true },
      })
    );
    expect(guarded).toMatchObject({
      success: true,
      request: {
        session: "opaque",
        action: {
          fromState: "doc-1:2",
          strictState: true,
        },
      },
    });

    for (const request of [
      { id: "open", type: "session", action: "open", browser: "default", page: "main", ttl: 300 },
      { id: "renew", type: "session", action: "renew", session: "opaque", ttl: 60 },
      { id: "close", type: "session", action: "close", session: "opaque" },
    ])
      expect(parseRequest(JSON.stringify(request))).toMatchObject({ success: true });
  });

  it("rejects session TTLs outside 1 through 3600 seconds", () => {
    for (const ttl of [0, 3601]) {
      expect(
        parseRequest(
          JSON.stringify({
            id: `ttl-${ttl}`,
            type: "session",
            action: "open",
            browser: "default",
            page: "main",
            ttl,
          })
        )
      ).toMatchObject({ success: false });
    }
  });

  it("preserves an optional session on arbitrary script execution", () => {
    expect(
      parseRequest(
        JSON.stringify({
          id: "execute-owner",
          type: "execute",
          browser: "default",
          script: "await browser.listPages()",
          session: "opaque-owner",
        })
      )
    ).toMatchObject({ success: true, request: { type: "execute", session: "opaque-owner" } });
  });
});
