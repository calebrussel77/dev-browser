import type { Locator, Page } from "playwright";

import { AgentProtocolError } from "../agent-protocol.js";
import { attemptErrorReason, emptyWaitEvents, trustedInputError, unchangedAttempt, withAttemptJournal } from "../action-journal.js";
import type { InteractiveRequest } from "../protocol.js";
import type { AttemptJournalEntry } from "../retry-policy.js";

type PrimitiveAction = Extract<InteractiveRequest["action"], { kind: "focus" | "press" | "paste" | "scroll" | "select" | "check" | "uncheck" | "hover" | "drag" }>;
type InputMethod = AttemptJournalEntry["inputMethod"];

export interface ResolvedTarget { locator: Locator; cleanup(): Promise<void> }
export interface PrimitiveContext {
  page: Page;
  action: PrimitiveAction;
  timeoutMs: number;
  resolve(ref: string): Promise<ResolvedTarget>;
  authorize(refs: string[]): Promise<void>;
}
export interface PrimitiveSummary {
  focusedRef?: string | null;
  pressed?: { ref: string; key: string };
  pasted?: { ref: string; characters: number; redacted: true };
  scroll?: { before: { x: number; y: number }; after: { x: number; y: number }; delta: { x: number; y: number }; steps: number; matched: boolean | null };
  selected?: { ref: string; value: string; label: string };
  checked?: { ref: string; checked: boolean };
  hovered?: { ref: string };
  dragged?: { from: string; to: string; method: "dragTo" };
  attemptJournal?: AttemptJournalEntry[];
}

async function assertActionable(locator: Locator, operation: string, applicability?: "select" | "check" | "paste" | "drag-source") {
  const visible = await locator.isVisible();
  const box = visible ? await locator.boundingBox() : null;
  if (!visible || !box || box.width <= 0 || box.height <= 0)
    throw new AgentProtocolError("TARGET_HIDDEN", `Cannot ${operation} a hidden control`, true);
  const state = await locator.evaluate((element) => {
    const control = element as HTMLInputElement;
    const tag = element.tagName.toLowerCase();
    return {
      disabled: ("disabled" in control && Boolean(control.disabled)) || element.getAttribute("aria-disabled") === "true",
      readOnly: ("readOnly" in control && Boolean(control.readOnly)) || element.getAttribute("aria-readonly") === "true",
      tag,
      inputType: tag === "input" ? control.type.toLowerCase() : "",
      contentEditable: (element as HTMLElement).isContentEditable,
      draggable: (element as HTMLElement).draggable,
    };
  });
  if (state.disabled || state.readOnly)
    throw new AgentProtocolError("TARGET_DISABLED", `Cannot ${operation} a disabled or readonly control`, true);
  if (applicability === "select" && state.tag !== "select")
    throw new AgentProtocolError("TARGET_MISSING", "Select requires a select control", true);
  if (applicability === "check" && (state.tag !== "input" || !["checkbox", "radio"].includes(state.inputType)))
    throw new AgentProtocolError("TARGET_MISSING", "Check requires a checkbox or radio control", true);
  if (applicability === "paste" && state.tag !== "textarea" && !state.contentEditable && (state.tag !== "input" || ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(state.inputType)))
    throw new AgentProtocolError("TARGET_MISSING", "Paste requires an editable text control", true);
  if (applicability === "drag-source" && !state.draggable)
    throw new AgentProtocolError("TARGET_MISSING", "Drag requires a draggable source", true);
}

const offsets = (page: Page) => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
const settleScroll = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function scrollUntil(page: Page, query: string, maxSteps: number, wheel: (deltaY: number) => Promise<void>) {
  const [kind, expected] = query.split(":", 2) as ["text" | "role", string];
  for (let step = 0; step <= maxSteps; step += 1) {
    const matched = await page.evaluate(({ kind, expected }) => {
      const normalized = expected.trim().toLowerCase();
      const intersectsViewport = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      };
      if (kind === "text") return Array.from(document.body.querySelectorAll("*")).some((element) => {
        if (!intersectsViewport(element)) return false;
        const ownText = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || "").join(" ").trim().toLowerCase();
        return ownText === normalized;
      });
      return Array.from(document.querySelectorAll("[role]")).some((element) => element.getAttribute("role")?.trim().toLowerCase() === normalized && intersectsViewport(element));
    }, { kind, expected });
    if (matched) return { steps: step, matched: true };
    if (step < maxSteps) {
      await wheel(await page.evaluate(() => Math.max(1, innerHeight)));
      await settleScroll(page);
    }
  }
  return { steps: maxSteps, matched: false };
}

export async function executePrimitive(context: PrimitiveContext): Promise<PrimitiveSummary> {
  const { page, action, resolve, authorize, timeoutMs } = context;
  const journal: AttemptJournalEntry[] = [];
  const entry = (method: InputMethod, reason: string): AttemptJournalEntry => ({
    attempt: journal.length + 1, startedAt: new Date().toISOString(), inputMethod: method,
    sideEffects: emptyWaitEvents(), change: unchangedAttempt(), retryDecision: "stop", reason,
  });
  const blocked = async (method: InputMethod, check: () => Promise<void>) => {
    try { await check(); }
    catch (error) {
      const typed = trustedInputError(error, page);
      journal.push(entry(method, attemptErrorReason(typed)));
      throw withAttemptJournal(typed, journal);
    }
  };
  const dispatch = async (method: InputMethod, refs: string[], input: () => Promise<void>) => {
    const startedAt = new Date().toISOString();
    try {
      await authorize(refs);
      await input();
      journal.push({ ...entry(method, "action-complete"), startedAt });
    } catch (error) {
      const typed = trustedInputError(error, page);
      journal.push({ ...entry(method, attemptErrorReason(typed)), startedAt });
      throw withAttemptJournal(typed, journal);
    }
  };
  const complete = (summary: PrimitiveSummary): PrimitiveSummary => ({ ...summary, attemptJournal: journal });

  if (action.kind === "scroll") {
    const before = await offsets(page);
    let steps = 1;
    let matched: boolean | null = null;
    if (action.ref) {
      const target = await resolve(action.ref);
      try {
        await blocked("locator", () => assertActionable(target.locator, "scroll"));
        await dispatch("locator", [action.ref], () => target.locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }));
      } finally { await target.cleanup(); }
    } else if (action.until) {
      ({ steps, matched } = await scrollUntil(page, action.until, action.maxSteps!, (deltaY) => dispatch("wheel", [], () => page.mouse.wheel(0, deltaY))));
    } else if (action.direction) {
      const axis = action.direction === "left" || action.direction === "right" ? "x" : "y";
      const sign = action.direction === "up" || action.direction === "left" ? -1 : 1;
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await dispatch("wheel", [], () => page.mouse.wheel(axis === "x" ? sign * viewport.width * action.pages! : 0, axis === "y" ? sign * viewport.height * action.pages! : 0));
      await settleScroll(page);
      steps = action.pages!;
    } else {
      await dispatch("wheel", [], () => page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0));
      await settleScroll(page);
    }
    const after = await offsets(page);
    return complete({ scroll: { before, after, delta: { x: after.x - before.x, y: after.y - before.y }, steps, matched } });
  }

  const refs = action.kind === "drag" ? [action.from, action.to] : [action.ref];
  const method: InputMethod = action.kind === "press" || action.kind === "paste" ? "keyboard" : action.kind === "focus" ? "focus" : action.kind;
  const targets: ResolvedTarget[] = [];
  try {
    for (const ref of refs) targets.push(await resolve(ref));
  } catch (error) {
    await Promise.allSettled(targets.map((target) => target.cleanup()));
    const typed = trustedInputError(error, page);
    journal.push(entry(method, attemptErrorReason(typed)));
    throw withAttemptJournal(typed, journal);
  }
  const target = targets[0]!;
  try {
    if (action.kind === "focus") {
      await blocked("focus", () => assertActionable(target.locator, "focus"));
      await dispatch("focus", refs, () => target.locator.focus({ timeout: timeoutMs }));
      return complete({ focusedRef: action.ref });
    }
    if (action.kind === "press") {
      await blocked("keyboard", () => assertActionable(target.locator, "press"));
      await dispatch("keyboard", refs, () => target.locator.press(action.key, { timeout: timeoutMs }));
      return complete({ focusedRef: action.ref, pressed: { ref: action.ref, key: action.key } });
    }
    if (action.kind === "paste") {
      await blocked("keyboard", () => assertActionable(target.locator, "paste into", "paste"));
      await dispatch("focus", refs, () => target.locator.focus({ timeout: timeoutMs }));
      await dispatch("keyboard", refs, () => page.keyboard.insertText(action.text));
      return complete({ focusedRef: action.ref, pasted: { ref: action.ref, characters: Array.from(action.text).length, redacted: true } });
    }
    if (action.kind === "select") {
      await blocked("select", () => assertActionable(target.locator, "select", "select"));
      let chosen: string[] = [];
      await dispatch("select", refs, async () => { chosen = await target.locator.selectOption(action.value !== undefined ? { value: action.value } : { label: action.label! }, { timeout: timeoutMs }); });
      const label = await target.locator.locator("option:checked").textContent() ?? "";
      return complete({ selected: { ref: action.ref, value: chosen[0] ?? "", label } });
    }
    if (action.kind === "check" || action.kind === "uncheck") {
      await blocked(action.kind, () => assertActionable(target.locator, action.kind, "check"));
      await dispatch(action.kind, refs, () => target.locator[action.kind]({ timeout: timeoutMs }));
      return complete({ checked: { ref: action.ref, checked: await target.locator.isChecked() } });
    }
    if (action.kind === "hover") {
      await blocked("hover", () => assertActionable(target.locator, "hover"));
      await dispatch("hover", refs, () => target.locator.hover({ timeout: timeoutMs }));
      return complete({ hovered: { ref: action.ref } });
    }
    await blocked("drag", async () => { await assertActionable(target.locator, "drag", "drag-source"); await assertActionable(targets[1]!.locator, "drop onto"); });
    await dispatch("drag", refs, () => target.locator.dragTo(targets[1]!.locator, { timeout: timeoutMs }));
    return complete({ dragged: { from: action.from, to: action.to, method: "dragTo" } });
  } finally {
    await Promise.allSettled(targets.map((resolved) => resolved.cleanup()));
  }
}
