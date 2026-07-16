import { describe, expect, it } from "vitest";

import { parseRequest } from "./protocol.js";

describe("interactive request protocol", () => {
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
