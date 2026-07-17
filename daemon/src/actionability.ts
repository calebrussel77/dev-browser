import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Locator, Page } from "playwright";
import { AgentProtocolError } from "./agent-protocol.js";
import { parseScopedRef, registeredFrame } from "./frame-registry.js";
import { frameAncestorsVisible, frameContentMatrix, frameToTopMatrix, projectPoint, projectRect } from "./frame-geometry.js";
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
  legacyRefs?: boolean;
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
  quad?: Array<{ x: number; y: number }>;
  scroll: { scrolled: boolean; before: { x: number; y: number }; after: { x: number; y: number } };
  actual: { role: string; name: string; tag: string };
  frameId?: string;
  framePath?: string[];
  shadowContext?: string[];
  cleanup(): Promise<void>;
}
export interface ActionTargetMetadata {
  originalRef: string;
  actualRef: string;
  resolvedBy: ResolvedActionTarget["resolvedBy"];
  actual: ResolvedActionTarget["actual"];
  frameId?: string;
  framePath?: string[];
  shadowContext?: string[];
  method: ActionTargetMethod;
  box: ResolvedActionTarget["box"];
  quad?: ResolvedActionTarget["quad"];
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
    frameId: target.frameId ?? "F0",
    framePath: target.framePath ?? ["F0"],
    shadowContext: target.shadowContext ?? [],
    method,
    box: target.box,
    quad: target.quad,
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

async function inspectTarget(locator: Locator, originalRef: string, legacyRefs = false) {
  return locator.evaluate((element, input) => {
    const { requestedRef, legacyRefs } = input;
    const tag = element.tagName.toLowerCase();
    const implicitRole =
      tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? "textbox" : "";
    const state = (
      window as Window & {
        __devBrowserPerceptionState?: { refs: WeakMap<Element, string>; boundedText?: (root: Node, maxChars?: number, maxNodes?: number) => { text: string } };
      }
    ).__devBrowserPerceptionState;
    const registeredRef = state?.refs.get(element);
    const attributeRef = element.getAttribute("data-dev-browser-ref");
    const rawName = legacyRefs
      ? element.getAttribute("aria-label") ?? element.textContent ?? ""
      : element.getAttribute("aria-label") ?? state?.boundedText?.(element, 500, 100).text ?? "";
    return {
      actual: {
        role: element.getAttribute("role") ?? implicitRole,
        name: rawName
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        tag,
      },
      actualRef:
        registeredRef ??
        (attributeRef && /^R\d+$/.test(attributeRef) ? attributeRef : requestedRef),
      shadowContext: (() => {
        const path: string[] = [];
        let current: Node = element;
        for (let depth = 0; depth < 20; depth += 1) {
          const root = current.getRootNode();
          if (!(root instanceof ShadowRoot)) break;
          const host = root.host;
          const testId = host.getAttribute("data-testid");
          path.unshift(`${host.tagName.toLowerCase()}${host.id ? `#${host.id.slice(0, 50)}` : ""}${testId ? `[data-testid=${testId.slice(0, 50)}]` : ""}`);
          current = host;
        }
        return path;
      })(),
    };
  }, { requestedRef: originalRef, legacyRefs });
}

export async function resolveActionTarget(
  page: Page,
  ref: string,
  options: ActionTargetOptions
): Promise<ResolvedActionTarget> {
  const pageName = options.pageName ?? "main";
  const scoped = parseScopedRef(ref);
  if (!scoped)
    return fail(pageName, "TARGET_MISSING", "Target ref is invalid", { ref: ref.slice(0, 80) });
  const frameEntry = scoped.frameId === "F0" ? registeredFrame(page, "F0") : registeredFrame(page, scoped.frameId);
  if (scoped.frameId !== "F0" && (!frameEntry || frameEntry.frame.isDetached()))
    throw new AgentProtocolError("FRAME_DETACHED", `Frame ${scoped.frameId} is detached or expired`, true, {
      details: { frameId: scoped.frameId }, nextCommands: [observeRecoveryCommand(pageName)],
    });
  const context: Page | Frame = frameEntry?.frame ?? page;
  if (frameEntry && !(await frameAncestorsVisible(frameEntry.frame)))
    return fail(pageName, "TARGET_HIDDEN", `Frame ${scoped.frameId} or an ancestor frame is hidden`, { frameId: scoped.frameId });
  const token = `dev-browser-${randomUUID()}`;
  const selector = `[data-dev-browser-action-ref="${token}"]`;
  let identity: ElementHandle<Element> | null = null;
  let previousActionAttribute: string | null = null;
  const handle = await context.evaluateHandle(({ requestedRef, legacyRefs }) => {
      const state = (
        window as Window & { __devBrowserPerceptionState?: { refs: WeakMap<Element, string>; byRef?: Map<string, WeakRef<Element>> } }
      ).__devBrowserPerceptionState;
      const candidate = state?.byRef?.get(requestedRef)?.deref();
      if (candidate && candidate.isConnected && state?.refs.get(candidate) === requestedRef) return candidate;
      return legacyRefs ? document.querySelector(`[data-dev-browser-ref="${requestedRef}"]`) : null;
    }, { requestedRef: scoped.localRef, legacyRefs: options.legacyRefs === true });
  identity = handle.asElement();
  if (!identity) {
    await handle.dispose();
    return fail(pageName, "TARGET_MISSING", `Target ref "${ref}" is missing`, { ref });
  }
  previousActionAttribute = await identity.getAttribute("data-dev-browser-action-ref");
  await identity.evaluate((element, ownedToken) => element.setAttribute("data-dev-browser-action-ref", ownedToken), token);
  let original = context.locator(selector).first();
  const cleanup = async () => {
    const owned = identity;
    identity = null;
    if (owned) {
      await owned.evaluate((element, state) => {
        if (element.getAttribute("data-dev-browser-action-ref") !== state.token) return;
        if (state.previous === null) element.removeAttribute("data-dev-browser-action-ref");
        else element.setAttribute("data-dev-browser-action-ref", state.previous);
      }, { token, previous: previousActionAttribute }).catch(() => {});
      await owned.dispose().catch(() => {});
    }
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
    const identityHandle = await locator.elementHandle();
    if (!identityHandle) return fail(pageName, "TARGET_MISSING", "Resolved target is missing");
    const initialTarget = await inspectTarget(locator, scoped.localRef, options.legacyRefs === true);
    // Reject intrinsic hidden/disabled/inapplicable states before asking
    // Playwright to wait for a scroll that can never make them actionable.
    await validateApplicability(locator, options.applicability, pageName);
    if (frameEntry && !(await frameAncestorsVisible(frameEntry.frame)))
      fail(pageName, "TARGET_HIDDEN", `Frame ${scoped.frameId} or an ancestor frame became hidden`, { frameId: scoped.frameId });
    const before = await offsets(page);
    if (options.scroll) {
      if (frameEntry && frameEntry.id !== "F0") {
        const chain: Frame[] = [];
        let cursor: Frame = frameEntry.frame;
        while (cursor.parentFrame()) { chain.unshift(cursor); cursor = cursor.parentFrame()!; }
        for (const child of chain) {
          const frameElement = await child.frameElement();
          try {
            await frameElement.evaluate((element) => (element as HTMLElement).scrollIntoView({ block: "center", inline: "center" }));
          } finally {
            await frameElement.dispose();
          }
        }
      }
      await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
    }
    const after = await offsets(page);
    const localBox = await stableBox(locator, options.timeoutMs, pageName);
    const current = await locator.elementHandle();
    if (!current)
      fail(pageName, "TARGET_MISSING", "Resolved target detached during stability sampling");
    const currentHandle = current!;
    const sameElement = await identityHandle.evaluate(
      (expected, live) => expected === live,
      currentHandle
    );
    await currentHandle.dispose();
    await identityHandle.dispose();
    if (!sameElement)
      fail(pageName, "TARGET_MISSING", "Resolved target changed during stability sampling", {
        originalRef: ref,
      });
    await validateApplicability(locator, options.applicability, pageName);
    const finalTarget = await inspectTarget(locator, scoped.localRef, options.legacyRefs === true);
    if (finalTarget.actualRef !== initialTarget.actualRef)
      fail(pageName, "TARGET_MISSING", "Resolved target identity changed during actionability checks", {
        originalRef: ref,
      });
    if (options.hitTest) {
      const obstruction = await locator.evaluate(
        (element, point) => {
          const root = element.getRootNode();
          const hit = root instanceof ShadowRoot
            ? root.elementFromPoint(point.x, point.y)
            : document.elementFromPoint(point.x, point.y);
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
        { x: localBox.x + localBox.width / 2, y: localBox.y + localBox.height / 2 }
      );
      if (obstruction)
        fail(pageName, "TARGET_OBSCURED", "Target center is obstructed", { obstruction });
      if (frameEntry && frameEntry.id !== "F0") {
        let child: Frame = frameEntry.frame;
        let projectedPoint = { x: localBox.x + localBox.width / 2, y: localBox.y + localBox.height / 2 };
        while (child.parentFrame()) {
          projectedPoint = projectPoint(await frameContentMatrix(child), projectedPoint);
          const frameElement = await child.frameElement();
          try {
            const frameObstruction = await frameElement.evaluate((element, point) => {
              const hit = document.elementFromPoint(point.x, point.y);
              if (!hit || hit === element || element.contains(hit) || hit.contains(element)) return null;
              return { tag: hit.tagName.toLowerCase(), role: hit.getAttribute("role") ?? "", name: (hit.getAttribute("aria-label") ?? "").slice(0, 80) };
            }, projectedPoint);
            if (frameObstruction)
              fail(pageName, "TARGET_OBSCURED", `Frame ${frameEntry.id} is obstructed in its parent`, { frameId: frameEntry.id, obstruction: frameObstruction });
          } finally {
            await frameElement.dispose();
          }
          child = child.parentFrame()!;
        }
      }
    }
    const box = await locator.boundingBox();
    if (!box) return fail(pageName, "TARGET_MISSING", "Resolved target has no top-level bounding box");
    const quad = projectRect(await frameToTopMatrix(frameEntry?.frame ?? page.mainFrame()), localBox).quad;
    return {
      locator,
      originalRef: ref,
      actualRef: scoped.frameId === "F0" ? finalTarget.actualRef : `${scoped.frameId}:${finalTarget.actualRef}`,
      resolvedBy,
      box,
      quad,
      scroll: { scrolled: before.x !== after.x || before.y !== after.y, before, after },
      actual: finalTarget.actual,
      frameId: scoped.frameId,
      framePath: frameEntry?.path ?? ["F0"],
      shadowContext: finalTarget.shadowContext,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (frameEntry?.frame.isDetached())
      throw new AgentProtocolError("FRAME_DETACHED", `Frame ${scoped.frameId} detached during actionability checks`, true, {
        details: { frameId: scoped.frameId }, nextCommands: [observeRecoveryCommand(pageName)],
      });
    throw error;
  }
}
