import type { Frame, Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { parseScopedRef, registeredFrame } from "./frame-registry.js";

export interface ContentScopeRequest {
  ref?: string;
  within?: string;
  maxChars?: number;
}

export interface ScopeMetadata {
  kind: "ref" | "within";
  value: string;
  frameId: string;
}

export interface ScopedTextResult {
  scope: ScopeMetadata;
  text: string;
  truncation: { truncated: boolean; chars: number; maxChars: number };
}

const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 200_000;

// `main`, `aside`, and `dialog` are bare landmark tokens; `role:<role>` and
// `name:<exact accessible name>` extend the same grammar used by find's
// `within` filter (daemon/src/targeting.ts) rather than inventing a new one.
const WITHIN_GRAMMAR = /^(main|aside|dialog|role:.{1,100}|name:.{1,200})$/;

export function isValidWithinScope(value: string): boolean {
  return WITHIN_GRAMMAR.test(value);
}

interface ScopeEvalOptions {
  ref?: string;
  within?: string;
  maxChars: number;
}

interface ScopeEvalResult {
  matched: boolean;
  ambiguous: boolean;
  count: number;
  text: string;
  truncated: boolean;
}

// Runs inside the page/frame realm via Playwright's evaluate; must be
// self-contained (no closures over module-level helpers).
function resolveScopedText({ ref, within, maxChars }: ScopeEvalOptions): ScopeEvalResult {
  type RealmState = { byRef?: Map<string, WeakRef<Element>> };
  const state = (window as Window & { __devBrowserPerceptionState?: RealmState })
    .__devBrowserPerceptionState;

  const accessibleName = (element: Element): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return aria.replace(/\s+/g, " ").trim();
    return (element.textContent ?? "").replace(/\s+/g, " ").trim();
  };

  let candidates: Element[] = [];
  if (ref) {
    const found = state?.byRef?.get(ref)?.deref();
    candidates = found && found.isConnected ? [found] : [];
  } else if (within) {
    const roleMatch = /^role:(.+)$/.exec(within);
    const nameMatch = /^name:(.+)$/.exec(within);
    if (within === "main") candidates = Array.from(document.querySelectorAll("main"));
    else if (within === "aside") candidates = Array.from(document.querySelectorAll("aside"));
    else if (within === "dialog")
      candidates = Array.from(document.querySelectorAll('dialog,[role="dialog"]'));
    else if (roleMatch)
      candidates = Array.from(
        document.querySelectorAll(`[role="${roleMatch[1]!.replace(/"/g, '\\"')}"]`)
      );
    else if (nameMatch) {
      const target = nameMatch[1]!.trim().toLowerCase();
      candidates = Array.from(
        document.querySelectorAll(
          "main,aside,nav,header,footer,section,article,dialog,[role],[aria-label]"
        )
      ).filter((element) => accessibleName(element).toLowerCase() === target);
    }
  }

  if (candidates.length !== 1)
    return {
      matched: candidates.length > 0,
      ambiguous: candidates.length > 1,
      count: candidates.length,
      text: "",
      truncated: false,
    };

  const root = candidates[0]!;
  const raw = (root as HTMLElement).innerText ?? root.textContent ?? "";
  const normalized = raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = normalized.length > maxChars;
  return {
    matched: true,
    ambiguous: false,
    count: 1,
    text: truncated ? normalized.slice(0, maxChars) : normalized,
    truncated,
  };
}

/**
 * Resolves a `ref` or `within` scope (the same grammar as find's `within`
 * filter, extended with `role:`/`name:` forms) to bounded, normalized text.
 * Used by the `text` and `assert` interactive actions.
 */
export async function resolveContentScope(
  page: Page,
  request: ContentScopeRequest
): Promise<ScopedTextResult> {
  if (request.ref && request.within)
    throw new AgentProtocolError(
      "UNSUPPORTED_CONTEXT",
      "Provide either ref or within, not both",
      false
    );
  if (!request.ref && !request.within)
    throw new AgentProtocolError("UNSUPPORTED_CONTEXT", "A ref or within scope is required", false);
  if (request.within && !isValidWithinScope(request.within))
    throw new AgentProtocolError(
      "UNSUPPORTED_CONTEXT",
      `Unsupported within scope "${request.within}"; use main, aside, dialog, role:<role>, or name:<exact name>`,
      false
    );

  const maxChars = Math.max(1, Math.min(request.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS));
  let frame: Page | Frame = page;
  let frameId = "F0";
  let localRef: string | undefined;

  if (request.ref) {
    const scoped = parseScopedRef(request.ref);
    if (!scoped)
      throw new AgentProtocolError("TARGET_MISSING", `Ref "${request.ref}" is invalid`, true, {
        details: { ref: request.ref },
      });
    frameId = scoped.frameId;
    localRef = scoped.localRef;
    if (frameId !== "F0") {
      const entry = registeredFrame(page, frameId);
      if (!entry || entry.frame.isDetached())
        throw new AgentProtocolError(
          "FRAME_DETACHED",
          `Frame ${frameId} is detached or expired`,
          true,
          { details: { frameId } }
        );
      frame = entry.frame;
    }
  }

  const raw = await frame.evaluate(resolveScopedText, {
    ref: localRef,
    within: request.within,
    maxChars,
  });

  if (!raw.matched) {
    throw new AgentProtocolError(
      "TARGET_MISSING",
      request.ref
        ? `Ref "${request.ref}" is missing or not attached`
        : `No element matched scope "${request.within}"`,
      true,
      { details: { ref: request.ref, within: request.within } }
    );
  }
  if (raw.ambiguous) {
    throw new AgentProtocolError(
      "AMBIGUOUS_TARGET",
      `Scope "${request.within}" matched ${raw.count} elements; refine with role: or name:`,
      true,
      { details: { within: request.within, count: raw.count } }
    );
  }

  return {
    scope: { kind: request.ref ? "ref" : "within", value: request.ref ?? request.within!, frameId },
    text: raw.text,
    truncation: { truncated: raw.truncated, chars: raw.text.length, maxChars },
  };
}

export type AssertMatchMode = "exact" | "contains";

export interface AssertScopeRequest extends ContentScopeRequest {
  text: string;
  match?: AssertMatchMode;
  nextCommands?: string[];
}

export interface AssertScopeResult {
  asserted: true;
  scope: ScopeMetadata;
  observed: string;
}

function normalizeAssertionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Reads bounded scoped text and compares it against an expected string
 * without any trusted input attempt. Failure raises a typed, recoverable
 * ASSERTION_FAILED error; the page is never mutated either way.
 */
export async function assertScopedText(
  page: Page,
  request: AssertScopeRequest
): Promise<AssertScopeResult> {
  const scoped = await resolveContentScope(page, { ref: request.ref, within: request.within });
  const match = request.match ?? "contains";
  const haystack = normalizeAssertionText(scoped.text);
  const needle = normalizeAssertionText(request.text);
  const passed = match === "exact" ? haystack === needle : haystack.includes(needle);
  if (!passed) {
    throw new AgentProtocolError(
      "ASSERTION_FAILED",
      `Expected text "${request.text}" was not found in scope (match: ${match})`,
      true,
      { details: { scope: scoped.scope, match }, nextCommands: request.nextCommands }
    );
  }
  return { asserted: true, scope: scoped.scope, observed: scoped.text };
}
