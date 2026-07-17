import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  DAEMON_PROTOCOL_VERSION,
  EXPECTED_PLAYWRIGHT_VERSION,
  OperationTracker,
  buildRuntimeHandshake,
  sha256,
} from "./runtime-handshake.js";
import { parseRequest } from "./protocol.js";

describe("runtime handshake", () => {
  it("parses bounded handshake and idle restart requests", () => {
    const hash = "a".repeat(64);
    expect(
      parseRequest(
        JSON.stringify({
          id: "handshake-1",
          type: "handshake",
          cliVersion: "0.2.8",
          cliBuildHash: hash,
          embeddedDaemonHash: hash,
          expectedDaemonHash: hash,
        })
      )
    ).toMatchObject({ success: true, request: { type: "handshake" } });
    expect(
      parseRequest(
        JSON.stringify({
          id: "restart-1",
          type: "restart",
          currentDaemonHash: hash,
          ifIdle: true,
        })
      )
    ).toMatchObject({ success: true, request: { type: "restart", ifIdle: true } });
  });

  it("reports client, daemon, protocol, playwright, and QuickJS provenance", async () => {
    const result = await buildRuntimeHandshake(
      {
        cliVersion: "0.2.8",
        cliBuildHash: "cli-hash",
        embeddedDaemonHash: "embedded-hash",
        expectedDaemonHash: "process-hash",
      },
      {
        processHash: async () => "process-hash",
        installedVersion: async (name) =>
          name === "playwright" ? EXPECTED_PLAYWRIGHT_VERSION : "0.32.1",
      }
    );

    expect(result).toMatchObject({
      client: {
        cliVersion: "0.2.8",
        cliBuildHash: "cli-hash",
        embeddedDaemonHash: "embedded-hash",
        expectedDaemonHash: "process-hash",
      },
      daemon: {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        processHash: "process-hash",
      },
      playwright: {
        expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
        installedVersion: EXPECTED_PLAYWRIGHT_VERSION,
      },
      quickjs: {
        packageVersion: "0.32.1",
        sandboxProtocolVersion: 1,
      },
    });
  });

  it("uses stable SHA-256 content identities", () => {
    expect(sha256("daemon bytes")).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256("daemon bytes")).toBe(sha256("daemon bytes"));
    expect(sha256("other bytes")).not.toBe(sha256("daemon bytes"));
  });

  it("resolves runtime packages for the TypeScript daemon override", async () => {
    const previous = process.env.DEV_BROWSER_PROCESS_ENTRY;
    process.env.DEV_BROWSER_PROCESS_ENTRY = path.join(process.cwd(), "src", "daemon.ts");
    try {
      const hash = "a".repeat(64);
      const result = await buildRuntimeHandshake({
        cliVersion: "0.2.8",
        cliBuildHash: hash,
        embeddedDaemonHash: hash,
        expectedDaemonHash: hash,
      });
      expect(result.daemon.processHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.playwright.installedVersion).toBe(EXPECTED_PLAYWRIGHT_VERSION);
      expect(result.quickjs.packageVersion).toMatch(/^0\.32\./);
    } finally {
      if (previous === undefined) delete process.env.DEV_BROWSER_PROCESS_ENTRY;
      else process.env.DEV_BROWSER_PROCESS_ENTRY = previous;
    }
  });
});

describe("operation tracker", () => {
  it("reserves restart only while idle and rejects new work after reservation", () => {
    const tracker = new OperationTracker();
    const finish = tracker.begin();
    expect(tracker.activeOperations).toBe(1);
    expect(tracker.reserveIdleRestart()).toEqual({ ok: false, activeOperations: 1 });

    finish();
    expect(tracker.reserveIdleRestart()).toEqual({ ok: true, activeOperations: 0 });
    expect(() => tracker.begin()).toThrow(/restart is pending/i);
  });

  it("releases operations exactly once", () => {
    const tracker = new OperationTracker();
    const finish = tracker.begin();
    finish();
    finish();
    expect(tracker.activeOperations).toBe(0);
  });
});
