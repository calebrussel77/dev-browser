import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Locator, Page } from "playwright";
import { AgentProtocolError } from "./agent-protocol.js";
import { parseScopedRef, registeredFrame } from "./frame-registry.js";
import { frameAncestorsVisible, frameContentMatrix, frameToTopMatrix, invalidateFrameGeometry, projectPoint, projectRect } from "./frame-geometry.js";
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

// Per-sample movement at or above this (px) is real motion, not compositing noise.
const STABLE_JITTER_PX = 1;
// Total wander from the first sample still treated as "in place" when the budget
// elapses without two calm samples. A target that only jitters sub-pixel around a
// fixed spot on a perpetually-repainting page (ads, presence dots, live timers)
// stays well inside this; a genuine layout shift, scroll, or slide-in blows past it.
const STABLE_DRIFT_PX = 5;

async function stableBox(
  locator: Locator,
  timeoutMs: number,
  pageName: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const budgetMs = Math.min(Math.max(timeoutMs, 200), 500);
  const box = await locator.evaluate(
    (element, config) =>
      new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
        type Box = { x: number; y: number; width: number; height: number };
        const read = (): Box => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const movedBy = (a: Box, b: Box, tolerance: number) =>
          (["x", "y", "width", "height"] as const).some(
            (key) => Math.abs(a[key] - b[key]) >= tolerance
          );
        const anchor = read();
        // Track the full extent every sample sweeps through, so the timeout path can
        // tell a target jittering in place (tiny extent) from one genuinely travelling
        // across the page (large extent), independent of where each sample happens to land.
        const min = { ...anchor };
        const max = { ...anchor };
        const widen = (box: Box) => {
          (["x", "y", "width", "height"] as const).forEach((key) => {
            if (box[key] < min[key]) min[key] = box[key];
            if (box[key] > max[key]) max[key] = box[key];
          });
        };
        let previous: Box | null = null;
        let last = anchor;
        let stable = 0;
        let settled = false;
        const finish = (value: Box | null) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve(value);
        };
        const timeout = window.setTimeout(() => {
          // Budget elapsed without two consecutive calm samples. On a page that
          // repaints forever the target itself is effectively in place, so proceed
          // with its latest box — but only when the whole sampled sweep stayed within
          // the drift bound. A genuinely moving target (scroll/slide/layout shift, fast
          // oscillation) sweeps a wide extent and is still rejected.
          const settledInPlace = (["x", "y", "width", "height"] as const).every(
            (key) => max[key] - min[key] < config.drift
          );
          finish(settledInPlace ? last : null);
        }, config.budget);
        const sample = () => {
          if (settled) return;
          last = read();
          widen(last);
          if (previous && !movedBy(last, previous, config.jitter)) stable += 1;
          else stable = 0;
          if (stable >= 2) {
            finish(last);
            return;
          }
          previous = last;
          window.setTimeout(sample, 25);
        };
        sample();
      }),
    { budget: budgetMs, jitter: STABLE_JITTER_PX, drift: STABLE_DRIFT_PX }
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
  const resolved = await context.evaluateHandle(
    ({ requestedRef, legacyRefs, ownedToken, applicability }) => {
      type Failure = {
        code: "TARGET_MISSING" | "TARGET_HIDDEN" | "TARGET_DISABLED";
        message: string;
        details?: Record<string, unknown>;
      };
      type Inspection = {
        actualRef: string;
        resolvedBy: "self" | "descendant" | "ancestor";
      };
      type ActionWindow = Window & {
        __devBrowserPerceptionState?: {
          refs: WeakMap<Element, string>;
          byRef?: Map<string, WeakRef<Element>>;
        };
        __devBrowserActionTargets?: Map<
          string,
          { previous: string | null; inspection: Inspection }
        >;
      };
      const failure = (code: Failure["code"], message: string, details?: Failure["details"]) => ({
        error: { code, message, details } satisfies Failure,
      });
      const actionWindow = window as ActionWindow;
      const state = actionWindow.__devBrowserPerceptionState;
      const observed = state?.byRef?.get(requestedRef)?.deref();
      const original =
        observed && observed.isConnected && state?.refs.get(observed) === requestedRef
          ? observed
          : legacyRefs
            ? document.querySelector(`[data-dev-browser-ref="${requestedRef}"]`)
            : null;
      if (!original) return failure("TARGET_MISSING", "Target ref is missing", { requestedRef });

      const originalStyle = getComputedStyle(original);
      if (
        original.hasAttribute("hidden") ||
        original.getAttribute("aria-hidden") === "true" ||
        originalStyle.display === "none" ||
        originalStyle.visibility === "hidden" ||
        originalStyle.visibility === "collapse"
      )
        return failure("TARGET_HIDDEN", "Target is explicitly hidden");

      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          element.isConnected &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          style.contentVisibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      let element = original;
      let resolvedBy: Inspection["resolvedBy"] = "self";
      const originalTag = original.tagName.toLowerCase();
      if (original.getAttribute("role") === "link" || originalTag === "a") {
        const descendant = original.querySelector(
          "button,[role='button'],input[type='button'],input[type='submit'],input[type='reset']"
        );
        if (descendant) {
          element = descendant;
          resolvedBy = "descendant";
        }
      }
      if (!visible(element)) {
        const ancestor = original.parentElement?.closest(
          "button,a[href],[role='button'],[role='link']"
        );
        if (ancestor && visible(ancestor)) {
          element = ancestor;
          resolvedBy = "ancestor";
        }
      }
      if (!visible(element)) return failure("TARGET_HIDDEN", "Target is hidden");

      const control = element as HTMLInputElement;
      const tag = element.tagName.toLowerCase();
      const inputType = tag === "input" ? control.type.toLowerCase() : "";
      const disabled =
        ("disabled" in control && Boolean(control.disabled)) ||
        element.getAttribute("aria-disabled") === "true";
      const readonly =
        ("readOnly" in control && Boolean(control.readOnly)) ||
        element.getAttribute("aria-readonly") === "true";
      if (disabled || readonly)
        return failure("TARGET_DISABLED", "Target is disabled or readonly");
      if (applicability === "select" && tag !== "select")
        return failure("TARGET_MISSING", "Select requires a select control");
      if (applicability === "check" && (tag !== "input" || !["checkbox", "radio"].includes(inputType)))
        return failure("TARGET_MISSING", "Check requires a checkbox or radio control");
      if (applicability === "upload" && (tag !== "input" || inputType !== "file"))
        return failure("TARGET_MISSING", "Upload requires a file input");
      if (
        (applicability === "type" || applicability === "paste") &&
        tag !== "textarea" &&
        !(element as HTMLElement).isContentEditable &&
        (tag !== "input" ||
          ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(inputType))
      )
        return failure(
          "TARGET_MISSING",
          `${applicability === "type" ? "Type" : "Paste"} requires an editable text control`
        );
      if (applicability === "drag-source" && !(element as HTMLElement).draggable)
        return failure("TARGET_MISSING", "Drag requires a draggable source");

      const actualRef = state?.refs.get(element) ?? requestedRef;
      const targets = actionWindow.__devBrowserActionTargets ?? new Map();
      actionWindow.__devBrowserActionTargets = targets;
      targets.set(ownedToken, {
        previous: element.getAttribute("data-dev-browser-action-ref"),
        inspection: { actualRef, resolvedBy },
      });
      element.setAttribute("data-dev-browser-action-ref", ownedToken);
      return { element };
    },
    {
      requestedRef: scoped.localRef,
      legacyRefs: options.legacyRefs === true,
      ownedToken: token,
      applicability: options.applicability,
    }
  );
  const elementProperty = await resolved.getProperty("element");
  identity = elementProperty.asElement();
  if (!identity) {
    const errorProperty = await resolved.getProperty("error");
    const error = (await errorProperty.jsonValue()) as
      | { code: "TARGET_MISSING" | "TARGET_HIDDEN" | "TARGET_DISABLED"; message: string; details?: Record<string, unknown> }
      | undefined;
    await errorProperty.dispose();
    await elementProperty.dispose();
    await resolved.dispose();
    return fail(pageName, error?.code ?? "TARGET_MISSING", error?.message ?? `Target ref "${ref}" is missing`, error?.details ?? { ref });
  }
  await resolved.dispose();
  const locator = context.locator(selector).first();
  const cleanup = async () => {
    const owned = identity;
    identity = null;
    if (owned) {
      await owned.evaluate((element, ownedToken) => {
        const actionWindow = window as Window & {
          __devBrowserActionTargets?: Map<string, { previous: string | null }>;
        };
        const record = actionWindow.__devBrowserActionTargets?.get(ownedToken);
        if (element.getAttribute("data-dev-browser-action-ref") === ownedToken) {
          if (!record || record.previous === null) element.removeAttribute("data-dev-browser-action-ref");
          else element.setAttribute("data-dev-browser-action-ref", record.previous);
        }
        actionWindow.__devBrowserActionTargets?.delete(ownedToken);
      }, token).catch(() => {});
      await owned.dispose().catch(() => {});
    }
  };
  try {
    const before = await offsets(page);
    if (options.scroll) {
      if (frameEntry && frameEntry.id !== "F0") {
        invalidateFrameGeometry(frameEntry.frame);
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
    }
    const stabilized = (await identity.evaluate(
      async (element, input) => {
        type Box = { x: number; y: number; width: number; height: number };
        const read = (): Box => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        if (!element.isConnected || element.getAttribute("data-dev-browser-action-ref") !== input.token)
          return { error: { code: "TARGET_MISSING" as const, message: "Resolved target detached before stability sampling" } };
        if (input.scroll)
          (element as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
        return await new Promise<
          | { box: Box }
          | { error: { code: "TARGET_MISSING"; message: string; details?: Record<string, unknown> } }
        >((resolve) => {
          const anchor = read();
          const min = { ...anchor };
          const max = { ...anchor };
          let previous = anchor;
          let stable = 0;
          let done = false;
          const widen = (box: Box) => {
            for (const key of ["x", "y", "width", "height"] as const) {
              min[key] = Math.min(min[key], box[key]);
              max[key] = Math.max(max[key], box[key]);
            }
          };
          const finish = (value: { box: Box } | { error: { code: "TARGET_MISSING"; message: string; details?: Record<string, unknown> } }) => {
            if (done) return;
            done = true;
            window.clearTimeout(timeout);
            resolve(value);
          };
          const timeout = window.setTimeout(() => {
            const settledInPlace = (["x", "y", "width", "height"] as const).every(
              (key) => max[key] - min[key] < input.drift
            );
            finish(
              settledInPlace
                ? { box: previous }
                : { error: { code: "TARGET_MISSING", message: "Target bounding box did not stabilize within the bounded interval", details: { unstable: true } } }
            );
          }, input.budgetMs);
          const sample = () => {
            if (done) return;
            if (!element.isConnected || element.getAttribute("data-dev-browser-action-ref") !== input.token) {
              finish({ error: { code: "TARGET_MISSING", message: "Resolved target changed during stability sampling" } });
              return;
            }
            const next = read();
            widen(next);
            const moved = (["x", "y", "width", "height"] as const).some(
              (key) => Math.abs(next[key] - previous[key]) >= input.jitter
            );
            stable = moved ? 0 : stable + 1;
            previous = next;
            if (stable >= 2) {
              finish({ box: next });
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      },
      {
        token,
        scroll: options.scroll,
        budgetMs: Math.min(Math.max(options.timeoutMs, 60), 120),
        jitter: STABLE_JITTER_PX,
        drift: STABLE_DRIFT_PX,
      }
    )) as
      | { box: { x: number; y: number; width: number; height: number } }
      | { error: { code: "TARGET_MISSING"; message: string; details?: Record<string, unknown> } };
    if ("error" in stabilized)
      return fail(pageName, stabilized.error.code, stabilized.error.message, stabilized.error.details);
    const after = await offsets(page);
    const final = (await identity.evaluate(
      (element, input) => {
        const actionWindow = window as Window & {
          __devBrowserPerceptionState?: {
            refs: WeakMap<Element, string>;
            boundedText?: (root: Node, maxChars?: number, maxNodes?: number) => { text: string };
          };
          __devBrowserActionTargets?: Map<
            string,
            { inspection: { actualRef: string; resolvedBy: "self" | "descendant" | "ancestor" } }
          >;
        };
        const record = actionWindow.__devBrowserActionTargets?.get(input.token);
        if (!record || !element.isConnected || element.getAttribute("data-dev-browser-action-ref") !== input.token)
          return { error: { code: "TARGET_MISSING" as const, message: "Resolved target changed during actionability checks" } };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (
          element.hasAttribute("hidden") ||
          element.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden" ||
          rect.width <= 0 ||
          rect.height <= 0
        )
          return { error: { code: "TARGET_HIDDEN" as const, message: "Target is hidden" } };
        const control = element as HTMLInputElement;
        const tag = element.tagName.toLowerCase();
        const inputType = tag === "input" ? control.type.toLowerCase() : "";
        if (
          ("disabled" in control && Boolean(control.disabled)) ||
          element.getAttribute("aria-disabled") === "true" ||
          ("readOnly" in control && Boolean(control.readOnly)) ||
          element.getAttribute("aria-readonly") === "true"
        )
          return { error: { code: "TARGET_DISABLED" as const, message: "Target is disabled or readonly" } };
        if (input.applicability === "select" && tag !== "select")
          return { error: { code: "TARGET_MISSING" as const, message: "Select requires a select control" } };
        if (input.applicability === "check" && (tag !== "input" || !["checkbox", "radio"].includes(inputType)))
          return { error: { code: "TARGET_MISSING" as const, message: "Check requires a checkbox or radio control" } };
        if (input.applicability === "upload" && (tag !== "input" || inputType !== "file"))
          return { error: { code: "TARGET_MISSING" as const, message: "Upload requires a file input" } };
        if (
          (input.applicability === "type" || input.applicability === "paste") &&
          tag !== "textarea" &&
          !(element as HTMLElement).isContentEditable &&
          (tag !== "input" || ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(inputType))
        )
          return { error: { code: "TARGET_MISSING" as const, message: `${input.applicability === "type" ? "Type" : "Paste"} requires an editable text control` } };
        if (input.applicability === "drag-source" && !(element as HTMLElement).draggable)
          return { error: { code: "TARGET_MISSING" as const, message: "Drag requires a draggable source" } };

        const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const drifted = (["x", "y", "width", "height"] as const).some(
          (key) => Math.abs(box[key] - input.expected[key]) >= input.drift
        );
        if (drifted)
          return { error: { code: "TARGET_MISSING" as const, message: "Target moved after stability sampling", details: { unstable: true } } };
        const state = actionWindow.__devBrowserPerceptionState;
        const actualRef = state?.refs.get(element) ?? input.requestedRef;
        if (actualRef !== record.inspection.actualRef)
          return { error: { code: "TARGET_MISSING" as const, message: "Resolved target identity changed during actionability checks" } };
        const implicitRole = tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? "textbox" : "";
        const rawName = input.legacyRefs
          ? element.getAttribute("aria-label") ?? element.textContent ?? ""
          : element.getAttribute("aria-label") ?? state?.boundedText?.(element, 500, 100).text ?? "";
        const shadowContext: string[] = [];
        let current: Node = element;
        for (let depth = 0; depth < 20; depth += 1) {
          const root = current.getRootNode();
          if (!(root instanceof ShadowRoot)) break;
          const host = root.host;
          const testId = host.getAttribute("data-testid");
          shadowContext.unshift(`${host.tagName.toLowerCase()}${host.id ? `#${host.id.slice(0, 50)}` : ""}${testId ? `[data-testid=${testId.slice(0, 50)}]` : ""}`);
          current = host;
        }
        let obstruction: null | { role: string; name: string; tag: string; box: { x: number; y: number; width: number; height: number } } = null;
        if (input.hitTest) {
          const root = element.getRootNode();
          const hit = root instanceof ShadowRoot
            ? root.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            : document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) {
            const hitRect = hit.getBoundingClientRect();
            obstruction = {
              role: hit.getAttribute("role") ?? "",
              name: (hit.getAttribute("aria-label") ?? "").slice(0, 80),
              tag: hit.tagName.toLowerCase(),
              box: { x: hitRect.x, y: hitRect.y, width: hitRect.width, height: hitRect.height },
            };
          }
        }
        return {
          box,
          obstruction,
          actualRef,
          resolvedBy: record.inspection.resolvedBy,
          actual: {
            role: element.getAttribute("role") ?? implicitRole,
            name: rawName.replace(/\s+/g, " ").trim().slice(0, 80),
            tag,
          },
          shadowContext,
        };
      },
      {
        token,
        requestedRef: scoped.localRef,
        legacyRefs: options.legacyRefs === true,
        applicability: options.applicability,
        hitTest: options.hitTest,
        expected: stabilized.box,
        drift: STABLE_DRIFT_PX,
      }
    )) as
      | {
          box: { x: number; y: number; width: number; height: number };
          obstruction: null | { role: string; name: string; tag: string; box: { x: number; y: number; width: number; height: number } };
          actualRef: string;
          resolvedBy: "self" | "descendant" | "ancestor";
          actual: { role: string; name: string; tag: string };
          shadowContext: string[];
        }
      | {
          error: {
            code: "TARGET_MISSING" | "TARGET_HIDDEN" | "TARGET_DISABLED";
            message: string;
            details?: Record<string, unknown>;
          };
        };
    if ("error" in final)
      return fail(pageName, final.error.code, final.error.message, final.error.details);
    if (final.obstruction)
      fail(pageName, "TARGET_OBSCURED", "Target center is obstructed", { obstruction: final.obstruction });
    const localBox = final.box;
    if (options.hitTest) {
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
    const projected = projectRect(await frameToTopMatrix(frameEntry?.frame ?? page.mainFrame()), localBox);
    return {
      locator,
      originalRef: ref,
      actualRef: scoped.frameId === "F0" ? final.actualRef : `${scoped.frameId}:${final.actualRef}`,
      resolvedBy: final.resolvedBy,
      box: projected.box,
      quad: projected.quad,
      scroll: { scrolled: before.x !== after.x || before.y !== after.y, before, after },
      actual: final.actual,
      frameId: scoped.frameId,
      framePath: frameEntry?.path ?? ["F0"],
      shadowContext: final.shadowContext,
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
