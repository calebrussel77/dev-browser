import { describe, expect, it } from "vitest";

import { authorizeExecuteRequest } from "./execute-policy.js";
import { PageLeaseManager } from "./sessions.js";

describe("QuickJS execute lease policy", () => {
  it("blocks a leased browser, authorizes its sole owner, and allows after close", () => {
    const leases = new PageLeaseManager(() => 1_000, () => "owner-session");
    const owner = leases.open("default", "main", 300);
    expect(() => authorizeExecuteRequest({ browser: "default" }, leases)).toThrowError(
      expect.objectContaining({ code: "LEASE_CONFLICT" })
    );
    expect(() => authorizeExecuteRequest({ browser: "default", session: owner.sessionId }, leases)).not.toThrow();
    leases.close(owner.sessionId);
    expect(() => authorizeExecuteRequest({ browser: "default" }, leases)).not.toThrow();
  });
});
