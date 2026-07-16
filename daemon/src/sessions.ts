import { randomBytes } from "node:crypto";

import { AgentProtocolError } from "./agent-protocol.js";

interface Lease { sessionId: string; browser: string; page: string; expiresAt: number }
export interface LeaseResult { sessionId: string; browser: string; page: string; expiresAt: number }

export class PageLeaseManager {
  private readonly byPage = new Map<string, Lease>();
  private readonly bySession = new Map<string, Lease>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly generateId: () => string = () => randomBytes(24).toString("base64url")
  ) {}

  private key(browser: string, page: string): string { return `${browser}\0${page}`; }

  private cleanup(): void {
    const now = this.now();
    for (const lease of this.bySession.values()) {
      if (lease.expiresAt <= now) this.remove(lease);
    }
  }

  private remove(lease: Lease): void {
    this.bySession.delete(lease.sessionId);
    if (this.byPage.get(this.key(lease.browser, lease.page)) === lease) {
      this.byPage.delete(this.key(lease.browser, lease.page));
    }
  }

  open(browser: string, page: string, ttl: number): LeaseResult {
    this.cleanup();
    const key = this.key(browser, page);
    if (this.byPage.has(key)) this.conflict(this.byPage.get(key)!);
    let sessionId = this.generateId();
    while (this.bySession.has(sessionId)) sessionId = this.generateId();
    const lease = { sessionId, browser, page, expiresAt: this.now() + ttl * 1_000 };
    this.byPage.set(key, lease);
    this.bySession.set(sessionId, lease);
    return { ...lease };
  }

  renew(sessionId: string, ttl: number): LeaseResult {
    this.cleanup();
    const lease = this.bySession.get(sessionId);
    if (!lease) throw new AgentProtocolError("LEASE_CONFLICT", "Session is expired or unknown", true);
    lease.expiresAt = this.now() + ttl * 1_000;
    return { ...lease };
  }

  close(sessionId: string): { closed: true } {
    this.cleanup();
    const lease = this.bySession.get(sessionId);
    if (!lease) throw new AgentProtocolError("LEASE_CONFLICT", "Session is expired or unknown", true);
    this.remove(lease);
    return { closed: true };
  }

  assertMutationAllowed(browser: string, page: string, sessionId?: string): void {
    this.cleanup();
    const lease = this.byPage.get(this.key(browser, page));
    if (!lease) return;
    if (sessionId === lease.sessionId) return;
    this.conflict(lease);
  }

  /** Arbitrary scripts cannot prove a page target, so authorization is browser-conservative. */
  assertBrowserMutationAllowed(browser: string, sessionId?: string): void {
    this.cleanup();
    const leases = [...this.bySession.values()].filter((lease) => lease.browser === browser);
    if (leases.length === 0) return;
    const first = leases[0]!;
    if (leases.length === 1 && sessionId === first.sessionId) return;
    this.conflict(first);
  }

  private conflict(lease: Lease): never {
    const remainingSeconds = Math.max(1, Math.ceil((lease.expiresAt - this.now()) / 1_000));
    throw new AgentProtocolError("LEASE_CONFLICT", "Page has an active writer lease", true, {
      details: { expiresInSeconds: Math.min(3_600, remainingSeconds) },
      nextCommands: ["dev-browser session open --browser default --page TARGET --ttl 300"],
    });
  }
}

export const pageLeases = new PageLeaseManager();
