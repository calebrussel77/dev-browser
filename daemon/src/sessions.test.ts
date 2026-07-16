import { describe, expect, it, vi } from "vitest";

import { PageLeaseManager } from "./sessions.js";

describe("page leases", () => {
  it("opens, renews, expires, and closes opaque page sessions", () => {
    let now = 1_000;
    const leases = new PageLeaseManager(() => now, () => "opaque-secret-session");
    const opened = leases.open("default", "main", 2);
    expect(opened).toMatchObject({ sessionId: "opaque-secret-session", expiresAt: 3_000 });
    expect(() => leases.assertMutationAllowed("default", "main")).toThrowError(
      expect.objectContaining({ code: "LEASE_CONFLICT" })
    );
    expect(() => leases.assertMutationAllowed("default", "main", opened.sessionId)).not.toThrow();
    now = 2_000;
    expect(leases.renew(opened.sessionId, 3).expiresAt).toBe(5_000);
    now = 5_001;
    expect(() => leases.assertMutationAllowed("default", "main")).not.toThrow();
    const reopened = leases.open("default", "main", 1);
    expect(leases.close(reopened.sessionId)).toEqual({ closed: true });
  });

  it("does not reveal a conflicting session id", () => {
    const leases = new PageLeaseManager(() => 1_000, () => "never-leak-this-secret");
    leases.open("default", "main", 300);
    try {
      leases.assertMutationAllowed("default", "main", "wrong-session");
      throw new Error("expected conflict");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("never-leak-this-secret");
      expect(error).toMatchObject({ code: "LEASE_CONFLICT", recoverable: true });
    }
  });

  it("blocks arbitrary browser scripts unless the sole browser lease matches", () => {
    const leases = new PageLeaseManager(() => 1_000, () => `session-${Math.random()}`);
    const owner = leases.open("default", "main", 300);
    expect(() => leases.assertBrowserMutationAllowed("default")).toThrowError(
      expect.objectContaining({ code: "LEASE_CONFLICT" })
    );
    expect(() => leases.assertBrowserMutationAllowed("default", owner.sessionId)).not.toThrow();
    leases.open("default", "other", 300);
    expect(() => leases.assertBrowserMutationAllowed("default", owner.sessionId)).toThrowError(
      expect.objectContaining({ code: "LEASE_CONFLICT" })
    );
    expect(() => leases.assertBrowserMutationAllowed("unleased")).not.toThrow();
  });
});
