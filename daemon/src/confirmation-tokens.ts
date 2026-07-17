import { createHash, randomBytes } from "node:crypto";
import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";

export interface ConfirmationScope {
  browser: string;
  pageName: string;
  page: Page;
  documentId: string;
  stateId: string;
  originalRef: string;
  resolvedRef: string;
  targetFingerprint: string;
  frameId: string;
  framePath: string[];
  shadowContext: string[];
  expectedText: string;
  confirmationText: string;
  url: string;
}

interface StoredScope extends Omit<ConfirmationScope, "expectedText" | "confirmationText" | "url"> {
  expectedHash: string;
  confirmationTextHash: string;
  urlHash: string;
  issuedAt: number;
  expiresAt: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const invalid = (): never => {
  throw new AgentProtocolError(
    "CONFIRMATION_INVALID",
    "Confirmation token is invalid, expired, already used, or no longer matches the target",
    true
  );
};

export class ConfirmationTokenRegistry {
  private readonly entries = new Map<string, StoredScope>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly pageTokens = new WeakMap<Page, Set<string>>();
  private readonly watchedPages = new WeakSet<Page>();
  private readonly trackedPages = new Set<Page>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000
  ) {}

  issue(scope: ConfirmationScope): { confirmationToken: string; issuedAt: string; expiresAt: string } {
    this.prune();
    const token = randomBytes(24).toString("base64url");
    const key = digest(token);
    const issuedAt = this.now();
    const entry: StoredScope = {
      browser: scope.browser,
      pageName: scope.pageName,
      page: scope.page,
      documentId: scope.documentId,
      stateId: scope.stateId,
      originalRef: scope.originalRef,
      resolvedRef: scope.resolvedRef,
      targetFingerprint: digest(scope.targetFingerprint),
      frameId: scope.frameId,
      framePath: [...scope.framePath],
      shadowContext: [...scope.shadowContext],
      expectedHash: digest(scope.expectedText),
      confirmationTextHash: digest(scope.confirmationText),
      urlHash: digest(normalizeUrl(scope.url)),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    this.entries.set(key, entry);
    if (this.now === Date.now) {
      const timer = setTimeout(() => this.deleteKey(key, scope.page), this.ttlMs);
      timer.unref();
      this.expiryTimers.set(key, timer);
    }
    const keys = this.pageTokens.get(scope.page) ?? new Set<string>();
    keys.add(key);
    this.pageTokens.set(scope.page, keys);
    this.trackedPages.add(scope.page);
    if (!this.watchedPages.has(scope.page)) {
      this.watchedPages.add(scope.page);
      scope.page.once("close", () => this.clearPage(scope.page));
    }
    return {
      confirmationToken: token,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    };
  }

  consume(token: string, scope: ConfirmationScope): void {
    const key = digest(token);
    const entry = this.entries.get(key);
    // Reservation and burn are synchronous and happen before any comparison.
    this.deleteKey(key, entry?.page);
    if (!entry || this.now() >= entry.expiresAt) return invalid();
    const matches =
      entry.browser === scope.browser &&
      entry.pageName === scope.pageName &&
      entry.page === scope.page &&
      !scope.page.isClosed() &&
      entry.documentId === scope.documentId &&
      entry.stateId === scope.stateId &&
      entry.originalRef === scope.originalRef &&
      entry.resolvedRef === scope.resolvedRef &&
      entry.targetFingerprint === digest(scope.targetFingerprint) &&
      entry.frameId === scope.frameId &&
      JSON.stringify(entry.framePath) === JSON.stringify(scope.framePath) &&
      JSON.stringify(entry.shadowContext) === JSON.stringify(scope.shadowContext) &&
      entry.confirmationTextHash === digest(scope.confirmationText) &&
      entry.urlHash === digest(normalizeUrl(scope.url));
    if (!matches) return invalid();
  }

  reset(): void {
    this.entries.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const page of this.trackedPages) this.pageTokens.delete(page);
    this.trackedPages.clear();
  }

  private clearPage(page: Page): void {
    for (const key of this.pageTokens.get(page) ?? []) this.deleteKey(key, page);
    this.pageTokens.delete(page);
    this.trackedPages.delete(page);
  }

  private deleteKey(key: string, page?: Page): void {
    this.entries.delete(key);
    if (page) {
      const keys = this.pageTokens.get(page);
      keys?.delete(key);
      if (keys?.size === 0) {
        this.pageTokens.delete(page);
        this.trackedPages.delete(page);
      }
    }
    const timer = this.expiryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now || entry.page.isClosed()) {
        this.deleteKey(key, entry.page);
      }
    }
    while (this.entries.size >= 1_000) {
      const key = this.entries.keys().next().value!;
      this.deleteKey(key, this.entries.get(key)?.page);
    }
  }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return value.trim();
  }
}

export const confirmationTokens = new ConfirmationTokenRegistry();
