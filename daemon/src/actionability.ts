import type { ElementHandle, Locator, Page } from "playwright";
import { AgentProtocolError } from "./agent-protocol.js";
import { observeRecoveryCommand } from "./recovery-command.js";

export type ActionApplicability =
  | "pointer"
  | "focus"
  | "keyboard"
  | "type"
  | "paste"
  | "select"
  | "check"
  | "drag-source"
  | "drop-target"
  | "upload";
export interface ActionTargetOptions {
  timeoutMs: number;
  scroll: boolean;
  hitTest: boolean;
  applicability: ActionApplicability;
  pageName?: string;
}
export type ActionTargetMethod =
  | "mouse"
  | "locator"
  | "keyboard"
  | "focus"
  | "select"
  | "check"
  | "uncheck"
  | "hover"
  | "drag"
  | "screenshot"
  | "upload";
export interface ResolvedActionTarget {
  locator: Locator;
  originalRef: string;
  actualRef: string;
  resolvedBy: "self" | "descendant" | "ancestor";
  box: { x: number; y: number; width: number; height: number };
  scroll: { scrolled: boolean; before: { x: number; y: number }; after: { x: number; y: number } };
  actual: { role: string; name: string; tag: string };
  cleanup(): Promise<void>;
}
export interface ActionTargetMetadata {
  originalRef: string;
  actualRef: string;
  resolvedBy: ResolvedActionTarget["resolvedBy"];
  actual: ResolvedActionTarget["actual"];
  method: ActionTargetMethod;
  box: ResolvedActionTarget["box"];
  scroll: ResolvedActionTarget["scroll"];
}

export function actionTargetMetadata(
  target: ResolvedActionTarget,
  method: ActionTargetMethod
): ActionTargetMetadata {
  return {
    originalRef: target.originalRef,
    actualRef: target.actualRef,
    resolvedBy: target.resolvedBy,
    actual: target.actual,
    method,
    box: target.box,
    scroll: target.scroll,
  };
}

const fail = (
  pageName: string,
  code:
    | "TARGET_MISSING"
    | "TARGET_HIDDEN"
    | "TARGET_OBSCURED"
    | "TARGET_DISABLED"
    | "UNSUPPORTED_CONTEXT",
  message: string,
  details?: Record<string, unknown>
): never => {
  throw new AgentProtocolError(code, message, true, {
    details,
    nextCommands: [observeRecoveryCommand(pageName)],
  });
};
const offsets = (page: Page) => page.evaluate(() => ({ x: scrollX, y: scrollY }));

async function stableBox(
  locator: Locator,
  timeoutMs: number,
  pageName: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const budgetMs = Math.min(Math.max(timeoutMs, 200), 500);
  const box = await locator.evaluate(
    (element, budget) =>
      new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
        let previous: { x: number; y: number; width: number; height: number } | null = null;
        let stable = 0;
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        }, budget);
        const sample = () => {
          if (settled) return;
          const rect = element.getBoundingClientRect();
          const current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          if (
            previous &&
            (["x", "y", "width", "height"] as const).every(
              (key) => Math.abs(current[key] - previous![key]) < 0.25
            )
          )
            stable += 1;
          else stable = 0;
          if (stable >= 2) {
            settled = true;
            window.clearTimeout(timeout);
            resolve(current);
            return;
          }
          previous = current;
          window.setTimeout(sample, 25);
        };
        sample();
      }),
    budgetMs
  );
  if (!box)
    return fail(
      pageName,
      "TARGET_MISSING",
      "Target bounding box did not stabilize within the bounded interval",
      { unstable: true }
    );
  return box;
}

async function validateApplicability(
  locator: Locator,
  applicability: ActionApplicability,
  pageName: string
) {
  if (!(await locator.isVisible())) fail(pageName, "TARGET_HIDDEN", "Target is hidden");
  const state = await locator.evaluate((element) => {
    const control = element as HTMLInputElement;
    const tag = element.tagName.toLowerCase();
    return {
      disabled:
        ("disabled" in control && Boolean(control.disabled)) ||
        element.getAttribute("aria-disabled") === "true",
      readonly:
        ("readOnly" in control && Boolean(control.readOnly)) ||
        element.getAttribute("aria-readonly") === "true",
      tag,
      inputType: tag === "input" ? control.type.toLowerCase() : "",
      editable: (element as HTMLElement).isContentEditable,
      draggable: (element as HTMLElement).draggable,
    };
  });
  if (state.disabled || state.readonly)
    fail(pageName, "TARGET_DISABLED", "Target is disabled or readonly");
  if (applicability === "select" && state.tag !== "select")
    fail(pageName, "TARGET_MISSING", "Select requires a select control");
  if (
    applicability === "check" &&
    (state.tag !== "input" || !["checkbox", "radio"].includes(state.inputType))
  )
    fail(pageName, "TARGET_MISSING", "Check requires a checkbox or radio control");
  if (applicability === "upload" && (state.tag !== "input" || state.inputType !== "file"))
    fail(pageName, "TARGET_MISSING", "Upload requires a file input");
  if (
    (applicability === "type" || applicability === "paste") &&
    state.tag !== "textarea" &&
    !state.editable &&
    (state.tag !== "input" ||
      [
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes(state.inputType))
  )
    fail(
      pageName,
      "TARGET_MISSING",
      `${applicability === "type" ? "Type" : "Paste"} requires an editable text control`
    );
  if (applicability === "drag-source" && !state.draggable)
    fail(pageName, "TARGET_MISSING", "Drag requires a draggable source");
}

async function inspectTarget(locator: Locator, originalRef: string) {
  return locator.evaluate((element, requestedRef) => {
    const tag = element.tagName.toLowerCase();
    const implicitRole =
      tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? "textbox" : "";
    const state = (
      window as Window & {
        __devBrowserPerceptionState?: { refs: WeakMap<Element, string> };
      }
    ).__devBrowserPerceptionState;
    const registeredRef = state?.refs.get(element);
    const attributeRef = element.getAttribute("data-dev-browser-ref");
    return {
      actual: {
        role: element.getAttribute("role") ?? implicitRole,
        name: (element.getAttribute("aria-label") ?? element.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        tag,
      },
      actualRef:
        registeredRef ??
        (attributeRef && /^R\d+$/.test(attributeRef) ? attributeRef : requestedRef),
    };
  }, originalRef);
}

export async function resolveActionTarget(
  page: Page,
  ref: string,
  options: ActionTargetOptions
): Promise<ResolvedActionTarget> {
  const pageName = options.pageName ?? "main";
  if (!/^R\d+$/.test(ref))
    fail(pageName, "TARGET_MISSING", "Target ref is invalid", { ref: ref.slice(0, 80) });
  let selector = `[data-dev-browser-ref="${ref}"]`;
  let temporary = false;
  let identity: ElementHandle<Element> | null = null;
  let original = page.locator(selector).first();
  if ((await original.count()) === 0) {
    temporary = await page.evaluate((requestedRef) => {
      const state = (
        window as Window & { __devBrowserPerceptionState?: { refs: WeakMap<Element, string> } }
      ).__devBrowserPerceptionState;
      const element = Array.from(document.querySelectorAll("*")).find(
        (candidate) => state?.refs.get(candidate) === requestedRef
      );
      if (!element) return false;
      element.setAttribute("data-dev-browser-action-ref", requestedRef);
      return true;
    }, ref);
    if (temporary) {
      selector = `[data-dev-browser-action-ref="${ref}"]`;
      original = page.locator(selector).first();
    }
  }
  const cleanup = async () => {
    await identity?.dispose().catch(() => {});
    identity = null;
    if (temporary)
      await page
        .locator(selector)
        .evaluateAll((elements) =>
          elements.forEach((element) => element.removeAttribute("data-dev-browser-action-ref"))
        )
        .catch(() => {});
  };
  try {
    if ((await original.count()) === 0)
      fail(pageName, "TARGET_MISSING", `Target ref "${ref}" is missing`, { ref });
    let locator = original;
    let resolvedBy: ResolvedActionTarget["resolvedBy"] = "self";
    const explicitlyHidden = await original.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.hasAttribute("hidden") ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      );
    });
    if (explicitlyHidden) fail(pageName, "TARGET_HIDDEN", "Target is explicitly hidden");
    const role = await original.getAttribute("role");
    if (
      role === "link" ||
      (await original.evaluate((element) => element.tagName.toLowerCase() === "a"))
    ) {
      const descendant = original
        .locator(
          "button,[role='button'],input[type='button'],input[type='submit'],input[type='reset']"
        )
        .first();
      if ((await descendant.count()) > 0) {
        locator = descendant;
        resolvedBy = "descendant";
      }
    }
    const originalBox = await locator.boundingBox();
    if (
      !(await locator.isVisible()) ||
      !originalBox ||
      originalBox.width <= 0 ||
      originalBox.height <= 0
    ) {
      const ancestor = original
        .locator(
          "xpath=ancestor::*[self::button or self::a[@href] or @role='button' or @role='link'][1]"
        )
        .first();
      if ((await ancestor.count()) > 0 && (await ancestor.isVisible())) {
        locator = ancestor;
        resolvedBy = "ancestor";
      }
    }
    identity = await locator.elementHandle();
    if (!identity) fail(pageName, "TARGET_MISSING", "Resolved target is missing");
    const identityHandle = identity!;
    const initialTarget = await inspectTarget(locator, ref);
    // Reject intrinsic hidden/disabled/inapplicable states before asking
    // Playwright to wait for a scroll that can never make them actionable.
    await validateApplicability(locator, options.applicability, pageName);
    const before = await offsets(page);
    if (options.scroll) {
      await locator.scrollIntoViewIfNeeded({ timeout: Math.max(options.timeoutMs, 500) });
    }
    const after = await offsets(page);
    const box = await stableBox(locator, options.timeoutMs, pageName);
    const current = await locator.elementHandle();
    if (!current)
      fail(pageName, "TARGET_MISSING", "Resolved target detached during stability sampling");
    const currentHandle = current!;
    const sameElement = await identityHandle.evaluate(
      (expected, live) => expected === live,
      currentHandle
    );
    await currentHandle.dispose();
    if (!sameElement)
      fail(pageName, "TARGET_MISSING", "Resolved target changed during stability sampling", {
        originalRef: ref,
      });
    await validateApplicability(locator, options.applicability, pageName);
    const finalTarget = await inspectTarget(locator, ref);
    if (finalTarget.actualRef !== initialTarget.actualRef)
      fail(pageName, "TARGET_MISSING", "Resolved target identity changed during actionability checks", {
        originalRef: ref,
      });
    if (options.hitTest) {
      const obstruction = await locator.evaluate(
        (element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          if (!hit || hit === element || element.contains(hit) || hit.contains(element))
            return null;
          const rect = hit.getBoundingClientRect();
          return {
            role: hit.getAttribute("role") ?? "",
            name: (hit.getAttribute("aria-label") ?? "").slice(0, 80),
            tag: hit.tagName.toLowerCase(),
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      );
      if (obstruction)
        fail(pageName, "TARGET_OBSCURED", "Target center is obstructed", { obstruction });
    }
    return {
      locator,
      originalRef: ref,
      actualRef: finalTarget.actualRef,
      resolvedBy,
      box,
      scroll: { scrolled: before.x !== after.x || before.y !== after.y, before, after },
      actual: finalTarget.actual,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
