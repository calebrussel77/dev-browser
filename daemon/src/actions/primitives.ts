import type { Page } from "playwright";

import { attemptErrorReason, attemptFrameContext, emptyWaitEvents, recordAttempt, trustedInputError, unchangedAttempt, withAttemptJournal } from "../action-journal.js";
import type { InteractiveRequest } from "../protocol.js";
import type { AttemptJournalEntry } from "../retry-policy.js";
import {
  actionTargetMetadata,
  type ActionTargetMetadata,
  type ActionTargetMethod,
  type ResolvedActionTarget,
} from "../actionability.js";

type PrimitiveAction = Extract<InteractiveRequest["action"], { kind: "focus" | "press" | "paste" | "scroll" | "select" | "check" | "uncheck" | "hover" | "drag" }>;
type InputMethod = AttemptJournalEntry["inputMethod"];

export interface PrimitiveContext {
  page: Page;
  action: PrimitiveAction;
  timeoutMs: number;
  resolve(ref: string, role?: "source" | "target"): Promise<ResolvedActionTarget>;
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
  targets?: ActionTargetMetadata[];
  attemptJournal?: AttemptJournalEntry[];
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
  let journalContext = attemptFrameContext(
    action.kind === "drag" ? action.from : action.kind === "scroll" ? action.ref ?? null : action.ref
  );
  const entry = (method: InputMethod, reason: string): AttemptJournalEntry => ({
    attempt: journal.length + 1, startedAt: new Date().toISOString(), inputMethod: method,
    sideEffects: emptyWaitEvents(), change: unchangedAttempt(), retryDecision: "stop", reason,
  });
  const dispatch = async (method: InputMethod, refs: string[], input: () => Promise<void>) => {
    const startedAt = new Date().toISOString();
    try {
      await authorize(refs);
      await input();
      recordAttempt(journal, { ...entry(method, "action-complete"), startedAt }, journalContext);
    } catch (error) {
      const typed = trustedInputError(error, page);
      recordAttempt(journal, { ...entry(method, attemptErrorReason(typed)), startedAt }, journalContext);
      throw withAttemptJournal(typed, journal);
    }
  };
  const complete = (
    summary: PrimitiveSummary,
    targets: ResolvedActionTarget[] = [],
    targetMethod?: ActionTargetMethod
  ): PrimitiveSummary => ({
    ...summary,
    targets: targetMethod
      ? targets.map((target) => actionTargetMetadata(target, targetMethod))
      : undefined,
    attemptJournal: journal,
  });

  if (action.kind === "scroll") {
    const before = await offsets(page);
    let steps = 1;
    let matched: boolean | null = null;
    let targetMetadata: ActionTargetMetadata[] | undefined;
    if (action.ref) {
      const target = await resolve(action.ref);
      journalContext = attemptFrameContext(action.ref, target);
      try {
        await dispatch("locator", [action.ref], () => target.locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }));
        targetMetadata = [actionTargetMetadata(target, "locator")];
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
    return { ...complete({ scroll: { before, after, delta: { x: after.x - before.x, y: after.y - before.y }, steps, matched } }), targets: targetMetadata };
  }

  const refs = action.kind === "drag" ? [action.from, action.to] : [action.ref];
  const method: InputMethod = action.kind === "press" || action.kind === "paste" ? "keyboard" : action.kind === "focus" ? "focus" : action.kind;
  const targets: ResolvedActionTarget[] = [];
  try {
    for (const [index, ref] of refs.entries()) targets.push(await resolve(ref, action.kind === "drag" ? (index === 0 ? "source" : "target") : undefined));
  } catch (error) {
    await Promise.allSettled(targets.map((target) => target.cleanup()));
    const typed = trustedInputError(error, page);
    recordAttempt(journal, entry(method, attemptErrorReason(typed)), journalContext);
    throw withAttemptJournal(typed, journal);
  }
  const target = targets[0]!;
  journalContext = attemptFrameContext(refs[0] ?? null, target);
  try {
    if (action.kind === "focus") {
      await dispatch("focus", refs, () => target.locator.focus({ timeout: timeoutMs }));
      return complete({ focusedRef: target.actualRef }, targets, "focus");
    }
    if (action.kind === "press") {
      await dispatch("keyboard", refs, () => target.locator.press(action.key, { timeout: timeoutMs }));
      return complete({ focusedRef: target.actualRef, pressed: { ref: target.actualRef, key: action.key } }, targets, "keyboard");
    }
    if (action.kind === "paste") {
      await dispatch("focus", refs, () => target.locator.focus({ timeout: timeoutMs }));
      await dispatch("keyboard", refs, () => page.keyboard.insertText(action.text));
      return complete({ focusedRef: target.actualRef, pasted: { ref: target.actualRef, characters: Array.from(action.text).length, redacted: true } }, targets, "keyboard");
    }
    if (action.kind === "select") {
      let chosen: string[] = [];
      await dispatch("select", refs, async () => { chosen = await target.locator.selectOption(action.value !== undefined ? { value: action.value } : { label: action.label! }, { timeout: timeoutMs }); });
      const label = await target.locator.locator("option:checked").textContent() ?? "";
      return complete({ selected: { ref: target.actualRef, value: chosen[0] ?? "", label } }, targets, "select");
    }
    if (action.kind === "check" || action.kind === "uncheck") {
      await dispatch(action.kind, refs, () => target.locator[action.kind]({ timeout: timeoutMs }));
      return complete({ checked: { ref: target.actualRef, checked: await target.locator.isChecked() } }, targets, action.kind);
    }
    if (action.kind === "hover") {
      await dispatch("hover", refs, () => target.locator.hover({ timeout: timeoutMs }));
      return complete({ hovered: { ref: target.actualRef } }, targets, "hover");
    }
    await dispatch("drag", refs, () => target.locator.dragTo(targets[1]!.locator, { timeout: timeoutMs }));
    return complete({ dragged: { from: target.actualRef, to: targets[1]!.actualRef, method: "dragTo" } }, targets, "drag");
  } finally {
    await Promise.allSettled(targets.map((resolved) => resolved.cleanup()));
  }
}
