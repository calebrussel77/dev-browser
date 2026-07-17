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

// The base grammar IS find's `within` grammar: any landmark-descriptor
// substring (matched with `landmarkScopeMatches` from daemon/src/targeting.ts
// — the same normalize-then-includes semantic findTargets uses), so values
// like `main`, `aside`, `nav`, `dialog`, or `conversation-list` resolve the
// way find filters them. `role:<role>` and `name:<exact accessible name>`
// are extensions layered on top, per the plan's "the find grammar wins and
// this step extends it" clause.
export function isValidWithinScope(value: string): boolean {
  if (value.length === 0 || value.length > 500) return false;
  const roleMatch = /^role:(.*)$/.exec(value);
  if (roleMatch) return roleMatch[1]!.length >= 1 && roleMatch[1]!.length <= 100;
  const nameMatch = /^name:(.*)$/.exec(value);
  if (nameMatch) return nameMatch[1]!.length >= 1 && nameMatch[1]!.length <= 200;
  return true;
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
// self-contained (no closures over module-level helpers). The matching
// semantics here MUST stay identical to the scope resolution duplicated in
// daemon/src/perception/realm-collector.ts (collectRealm) and to
// landmarkScopeMatches in daemon/src/targeting.ts; DOM-resolution tests in
// scoped-content.test.ts cross-check all three.
function resolveScopedText({ ref, within, maxChars }: ScopeEvalOptions): ScopeEvalResult {
  type RealmState = { byRef?: Map<string, WeakRef<Element>> };
  const state = (window as Window & { __devBrowserPerceptionState?: RealmState })
    .__devBrowserPerceptionState;

  // Same normalize as targeting.ts normalizeMatchText.
  const normalizeMatch = (value: string): string =>
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const compact = (value: string | null | undefined, max = 180) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  // Same bounded walker as realm-collector's boundedDescendantText.
  const boundedText = (root: Node, maxTextChars = 500, maxNodes = 100): string => {
    const stack: Node[] = [root];
    let text = "";
    let visited = 0;
    while (stack.length > 0 && visited < maxNodes && text.length < maxTextChars) {
      const current = stack.pop()!;
      visited += 1;
      if (current.nodeType === Node.TEXT_NODE) {
        text += (current as Text).data.slice(0, maxTextChars - text.length);
        continue;
      }
      const children = current.childNodes;
      const remainingNodes = Math.max(0, maxNodes - visited - stack.length);
      const selected = Math.min(children.length, remainingNodes);
      for (let index = selected - 1; index >= 0; index -= 1) stack.push(children.item(index)!);
    }
    return text.replace(/\s+/g, " ").trim();
  };
  // Identical to realm-collector's accessibleScopeName: aria-label compacted
  // to 180 chars, else bounded descendant text (500 chars / 100 nodes).
  const accessibleName = (element: Element): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return compact(aria);
    return boundedText(element, 500, 100);
  };
  // Same descriptor format as realm-collector's ancestors()/find landmarks.
  const descriptorFor = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${compact(element.id, 50)}` : "";
    const role = element.getAttribute("role");
    return `${tag}${id}${role ? `[role=${role}]` : ""}`;
  };

  const containerSelector =
    "main,aside,nav,header,footer,section,article,dialog,[role],[aria-label]";
  let candidates: Element[] = [];
  if (ref) {
    const found = state?.byRef?.get(ref)?.deref();
    candidates = found && found.isConnected ? [found] : [];
  } else if (within) {
    const roleMatch = /^role:(.+)$/.exec(within);
    const nameMatch = /^name:(.+)$/.exec(within);
    if (roleMatch)
      candidates = Array.from(
        document.querySelectorAll(`[role="${roleMatch[1]!.replace(/"/g, '\\"')}"]`)
      );
    else if (nameMatch) {
      const target = nameMatch[1]!.trim().toLowerCase();
      candidates = Array.from(document.querySelectorAll(containerSelector)).filter(
        (element) => accessibleName(element).toLowerCase() === target
      );
    } else {
      // Find's within semantic: normalized substring match against the
      // landmark descriptor. Nested matches collapse to the outermost
      // container, which covers the same subtree find's filter would.
      const needle = normalizeMatch(within);
      const matched = needle
        ? Array.from(document.querySelectorAll(containerSelector)).filter((element) =>
            normalizeMatch(descriptorFor(element)).includes(needle)
          )
        : [];
      candidates = matched.filter(
        (element) => !matched.some((other) => other !== element && other.contains(element))
      );
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
      `Unsupported within scope "${request.within}"; use a landmark substring (find's within grammar), role:<role>, or name:<exact name>`,
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
      { details: request.ref ? { ref: request.ref } : { within: request.within } }
    );
  }
  if (raw.ambiguous) {
    throw new AgentProtocolError(
      "AMBIGUOUS_TARGET",
      `Scope "${request.within}" matched ${raw.count} elements; refine the landmark substring or use role:/name:`,
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
