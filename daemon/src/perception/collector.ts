import type { Frame, Page } from "playwright";

import { AgentProtocolError } from "../agent-protocol.js";
import { beginFrameGeneration, parseScopedRef, registerFrames, stableFrameId, type RegisteredFrame } from "../frame-registry.js";
import { frameAncestorsVisible, frameContentMatrix, frameToTopMatrix, projectPoint, projectRect } from "../frame-geometry.js";
import { recordPageState, type PerceptionDelta } from "../page-state.js";
import { collectRealm } from "./realm-collector.js";
import { buildCompactTree } from "./tree.js";

export interface CollectPageStateOptions {
  full?: boolean;
  delta?: boolean;
  track?: string;
  maxNodes?: number;
  maxChars?: number;
  depth?: number;
  breadth?: number;
  continuation?: string;
  legacyRefs?: boolean;
  scope?: { ref?: string; within?: string };
  textOnly?: boolean;
}

export interface PerceptionElement {
  ref: string;
  role: string;
  name: string;
  description: string;
  landmark: string;
  semanticAncestors: string[];
  box: { x: number; y: number; width: number; height: number };
  quad?: Array<{ x: number; y: number }>;
  visible: boolean;
  inViewport: boolean;
  actionable: boolean;
  scrollable?: boolean;
  obscured: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  checked: boolean | "mixed" | null;
  selected: boolean | null;
  expanded: boolean | null;
  pressed: boolean | "mixed" | null;
  current: string | boolean | null;
  value?: string | null;
  placeholder: string;
  inputType: string;
  stableAttributes: { id: string; testId: string; href: string };
  focused: boolean;
  nearby: { heading: string; label: string; context: string };
  frameId: string;
  framePath?: string[];
  frameUrl?: string;
  frameName?: string;
  frameDocumentId?: string;
  shadowContext: string[];
  depth: number;
}

export interface PagePerception {
  documentId: string;
  stateId: string;
  url: string;
  title: string;
  coordinateSpace: {
    unit: "css-px";
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    scroll: { x: number; y: number };
    screenshotScale: "css";
  };
  focusedRef: string | null;
  tree: string;
  elements: PerceptionElement[];
  delta: PerceptionDelta | null;
  warnings: string[];
  truncation: { truncated: boolean; omittedNodes: number; continuation: string | null };
  scope?: { kind: "ref" | "within"; value: string; frameId: string } | null;
  textOnly?: { text: string; truncation: { truncated: boolean; chars: number; maxChars: number } };
}

const DEFAULTS = { maxNodes: 100, maxChars: 12_000, depth: 12, breadth: 50 };
const MAX_FRAMES_PER_OBSERVATION = 64;
const MAX_RECORDS_PER_OBSERVATION = 2_000;
const MAX_WORK_PER_FRAME = 5_000;

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8")
    .toString("base64url")
    .slice(0, 80);
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor || cursor.length > 80) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      offset?: unknown;
    };
    if (parsed.v === 1 && Number.isInteger(parsed.offset) && Number(parsed.offset) >= 0) {
      return Number(parsed.offset);
    }
  } catch {
    // Converted to a bounded typed protocol error below.
  }
  throw new AgentProtocolError("STALE_STATE", "Invalid or expired continuation cursor", true, {
    nextCommands: ["dev-browser observe"],
  });
}

async function collectLegacyPageState(
  page: Page,
  options: CollectPageStateOptions = {}
): Promise<PagePerception> {
  const full = options.full ?? false;
  const maxDepth = bounded(options.depth, DEFAULTS.depth, 50);
  const breadth = bounded(options.breadth, DEFAULTS.breadth, 500);
  const raw = await page.evaluate(
    ({ full, maxDepth, breadth, legacyRefs }) => {
      type RealmState = { token: string; refs: WeakMap<Element, string>; counter: number };
      type RealmWindow = Window & { __devBrowserPerceptionState?: RealmState };
      const realmWindow = window as RealmWindow;
      if (!realmWindow.__devBrowserPerceptionState) {
        Object.defineProperty(realmWindow, "__devBrowserPerceptionState", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: {
            token: `${Date.now()}-${Math.random()}`,
            refs: new WeakMap<Element, string>(),
            counter: 1,
          },
        });
      }
      const registry = realmWindow.__devBrowserPerceptionState!;
      const actionableSelector =
        "a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex]:not([tabindex='-1'])";
      const includeSelector = `${actionableSelector},h1,h2,h3,h4,h5,h6,main,nav,aside,header,footer,section,article,p,label,output`;
      const compact = (value: string | null | undefined, max = 180) =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const roleFor = (element: HTMLElement): string => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "textarea" || element.isContentEditable) return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "input") {
          const type = (element.getAttribute("type") ?? "text").toLowerCase();
          if (["button", "submit", "reset"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          return "textbox";
        }
        return tag;
      };
      const referencedText = (attribute: string, element: HTMLElement) =>
        compact(
          (element.getAttribute(attribute) ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        );
      const labelFor = (element: HTMLElement) =>
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? compact(Array.from(element.labels ?? [], (label) => label.textContent ?? "").join(" "))
          : "";
      const nameFor = (element: HTMLElement) =>
        compact(
          element.getAttribute("aria-label") ||
            referencedText("aria-labelledby", element) ||
            labelFor(element) ||
            element.innerText ||
            element.getAttribute("alt") ||
            element.getAttribute("title") ||
            element.getAttribute("placeholder")
        );
      const bool = (element: HTMLElement, name: string): boolean | null => {
        const value = element.getAttribute(name);
        return value === null ? null : value === "true";
      };
      const mixedBool = (element: HTMLElement, name: string): boolean | "mixed" | null => {
        const value = element.getAttribute(name);
        return value === "mixed" ? "mixed" : value === null ? null : value === "true";
      };
      const semanticAncestors = (element: HTMLElement) => {
        const values: string[] = [];
        let parent = element.parentElement;
        while (parent && parent !== document.body) {
          const tag = parent.tagName.toLowerCase();
          const role = parent.getAttribute("role");
          if (
            ["main", "aside", "nav", "header", "footer", "section", "article", "dialog"].includes(
              tag
            ) ||
            role
          ) {
            values.unshift(
              `${tag}${parent.id ? `#${compact(parent.id, 50)}` : ""}${role ? `[role=${role}]` : ""}`
            );
          }
          parent = parent.parentElement;
        }
        return values;
      };
      const depthFor = (element: HTMLElement) => {
        let depth = 0;
        let parent = element.parentElement;
        while (parent && parent !== document.body) {
          depth += 1;
          parent = parent.parentElement;
        }
        return depth;
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(includeSelector));
      const usedRefs = new Set(
        Array.from(document.querySelectorAll<HTMLElement>("[data-dev-browser-ref]"))
          .map((element) => element.getAttribute("data-dev-browser-ref") ?? "")
          .filter((ref) => /^R\d+$/.test(ref))
      );
      const records = candidates.map((element) => {
        const actionable = element.matches(actionableSelector);
        const legacyRef = element.getAttribute("data-dev-browser-ref") ?? "";
        let ref = actionable
          ? (registry.refs.get(element) ?? (/^R\d+$/.test(legacyRef) ? legacyRef : ""))
          : "";
        if (actionable && !ref) {
          do {
            ref = `R${registry.counter++}`;
          } while (usedRefs.has(ref));
          registry.refs.set(element, ref);
          usedRefs.add(ref);
        } else if (actionable && ref) {
          registry.refs.set(element, ref);
          registry.counter = Math.max(registry.counter, Number.parseInt(ref.slice(1), 10) + 1);
        }
        if (actionable && legacyRefs && !element.hasAttribute("data-dev-browser-ref")) {
          element.setAttribute("data-dev-browser-ref", ref);
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0;
        const inViewport =
          visible &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= innerHeight &&
          rect.left <= innerWidth;
        const centerX = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const centerY = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const hit = inViewport ? document.elementFromPoint(centerX, centerY) : null;
        const obscured = Boolean(
          actionable &&
          inViewport &&
          hit &&
          hit !== element &&
          !element.contains(hit) &&
          !hit.contains(element)
        );
        const input =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element
            : null;
        const rawValue =
          element instanceof HTMLInputElement && ["password", "hidden"].includes(element.type)
            ? element.value
              ? "[redacted]"
              : ""
            : element instanceof HTMLInputElement && element.type === "file"
              ? element.files?.length
                ? "[file selected]"
                : ""
              : input
                ? input.value
                : element.isContentEditable
                  ? (element.textContent ?? "")
                  : "";
        const checked =
          element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
            ? element.indeterminate
              ? "mixed"
              : element.checked
            : mixedBool(element, "aria-checked");
        const heading = element
          .closest("section,article,main,aside")
          ?.querySelector("h1,h2,h3,h4,h5,h6");
        const context = compact(element.parentElement?.textContent, 240);
        return {
          ref,
          role: roleFor(element),
          name: nameFor(element),
          description: compact(
            element.getAttribute("aria-description") || referencedText("aria-describedby", element)
          ),
          landmark: semanticAncestors(element).join(" > ") || "body",
          semanticAncestors: semanticAncestors(element),
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
          inViewport,
          actionable,
          obscured,
          disabled:
            "disabled" in element
              ? Boolean((element as HTMLInputElement).disabled)
              : bool(element, "aria-disabled") === true,
          readonly:
            "readOnly" in element
              ? Boolean((element as HTMLInputElement).readOnly)
              : bool(element, "aria-readonly") === true,
          required:
            "required" in element
              ? Boolean((element as HTMLInputElement).required)
              : bool(element, "aria-required") === true,
          checked,
          selected:
            element instanceof HTMLOptionElement
              ? element.selected
              : bool(element, "aria-selected"),
          expanded: bool(element, "aria-expanded"),
          pressed: mixedBool(element, "aria-pressed"),
          current: element.hasAttribute("aria-current")
            ? element.getAttribute("aria-current") || true
            : null,
          ...(full ? { value: compact(rawValue, 500) } : {}),
          placeholder: compact(element.getAttribute("placeholder")),
          inputType: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
          stableAttributes: {
            id: compact(element.id, 100),
            testId: compact(element.getAttribute("data-testid"), 100),
            href: element instanceof HTMLAnchorElement ? compact(element.getAttribute("href"), 300) : "",
          },
          focused: document.activeElement === element,
          nearby: {
            heading: compact(heading?.textContent),
            label: labelFor(element),
            context: full ? context : "",
          },
          frameId: "F0" as const,
          shadowContext: [] as [],
          depth: depthFor(element),
        };
      });
      return {
        realmToken: registry.token,
        url: location.href,
        title: document.title,
        coordinateSpace: {
          unit: "css-px" as const,
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          scroll: { x: scrollX, y: scrollY },
          screenshotScale: "css" as const,
        },
        focusedRef: records.find((record) => record.focused)?.ref || null,
        records,
      };
    },
    { full, maxDepth, breadth, legacyRefs: options.legacyRefs ?? false }
  );

  const maxNodes = bounded(options.maxNodes, DEFAULTS.maxNodes, 1_000);
  const maxChars = bounded(options.maxChars, DEFAULTS.maxChars, 100_000);
  const offset = decodeCursor(options.continuation);
  if (offset > raw.records.length) {
    throw new AgentProtocolError("STALE_STATE", "Invalid or expired continuation cursor", true, {
      nextCommands: ["dev-browser observe"],
    });
  }
  const built = buildCompactTree(raw.records as unknown as PerceptionElement[], maxNodes, maxChars, offset, maxDepth, breadth);
  const omittedNodes = built.omittedNodes;
  const history = recordPageState(
    page,
    raw.realmToken,
    options.track ?? "default",
    {
      url: raw.url,
      title: raw.title,
      focusedRef: raw.focusedRef,
      elements: raw.records as unknown as PerceptionElement[],
    },
    options.delta ?? false
  );

  return {
    documentId: history.documentId,
    stateId: history.stateId,
    url: raw.url,
    title: raw.title,
    coordinateSpace: raw.coordinateSpace,
    focusedRef: raw.focusedRef,
    tree: built.tree,
    elements: built.elements,
    delta: history.delta,
    warnings: [],
    truncation: {
      truncated: omittedNodes > 0,
      omittedNodes,
      continuation: built.omittedNodes > 0 ? encodeCursor(offset + built.consumedNodes) : null,
    },
  };
}

const MAX_FRAME_CANDIDATE_SCAN = 128;

export function boundedCandidatePrefix<T>(children: ArrayLike<T>, limit = MAX_FRAME_CANDIDATE_SCAN): { items: T[]; truncated: boolean } {
  const count = Math.min(children.length, limit);
  const items: T[] = [];
  for (let index = 0; index < count; index += 1) items.push(children[index]!);
  return { items, truncated: children.length > count };
}

async function deterministicFrames(page: Page): Promise<{ entries: Array<{ frame: Frame; id: string; path: string[] }>; truncated: boolean }> {
  const ordered: Array<{ frame: Frame; id: string; path: string[] }> = [];
  let truncated = false;
  const domChildren = async (frame: Frame): Promise<{ frames: Frame[]; truncated: boolean }> => {
    const result = await frame.evaluateHandle(({ maxFrames, maxWork }) => {
      const elements: Element[] = [], stack: Element[] = [];
      let work = 0, wasTruncated = false;
      const pushReverse = (children: HTMLCollection) => {
        const remaining = Math.max(0, maxWork - work - stack.length);
        const selected = Math.min(children.length, remaining);
        if (children.length > selected) wasTruncated = true;
        for (let index = selected - 1; index >= 0; index -= 1) stack.push(children.item(index)!);
      };
      pushReverse(document.documentElement?.children ?? document.children);
      while (stack.length > 0 && work < maxWork && elements.length < maxFrames) {
        const element = stack.pop()!; work += 1;
        if (element.matches("iframe,frame")) elements.push(element);
        const remaining = Math.max(0, maxWork - work - stack.length);
        const lightCount = Math.min(element.children.length, remaining);
        const shadow = element.shadowRoot?.children;
        const shadowCount = Math.min(shadow?.length ?? 0, remaining - lightCount);
        if (lightCount < element.children.length || shadowCount < (shadow?.length ?? 0)) wasTruncated = true;
        for (let index = shadowCount - 1; index >= 0; index -= 1) stack.push(shadow!.item(index)!);
        for (let index = lightCount - 1; index >= 0; index -= 1) stack.push(element.children.item(index)!);
      }
      if (stack.length > 0 || elements.length >= maxFrames) wasTruncated = true;
      return { elements, truncated: wasTruncated };
    }, { maxFrames: MAX_FRAME_CANDIDATE_SCAN, maxWork: 1_000 });
    try {
      const truncatedHandle = await result.getProperty("truncated");
      const wasTruncated = await truncatedHandle.jsonValue() as boolean;
      await truncatedHandle.dispose();
      const elementsHandle = await result.getProperty("elements");
      try {
        const properties = await elementsHandle.getProperties();
        const frames: Frame[] = [];
        for (let index = 0; index < MAX_FRAME_CANDIDATE_SCAN; index += 1) {
          const handle = properties.get(String(index))?.asElement();
          if (!handle) break;
          const child = await handle.contentFrame();
          if (child) frames.push(child);
          await handle.dispose();
        }
        return { frames, truncated: wasTruncated };
      } finally { await elementsHandle.dispose(); }
    } finally { await result.dispose(); }
  };
  const visit = async (frame: Frame, path: string[]) => {
    if (ordered.length >= MAX_FRAMES_PER_OBSERVATION) return;
    const id = stableFrameId(page, frame);
    ordered.push({ frame, id, path: [...path, id] });
    const selected = await domChildren(frame);
    truncated ||= selected.truncated;
    const selectedSet = new Set(selected.frames);
    const fallback = selected.truncated ? [] : frame.childFrames().filter((child) => !selectedSet.has(child))
      .sort((left, right) => left.name().localeCompare(right.name()) || left.url().localeCompare(right.url()));
    const remainingCandidates = Math.max(0, MAX_FRAME_CANDIDATE_SCAN - selected.frames.length);
    if (fallback.length > remainingCandidates) truncated = true;
    const candidates = [...selected.frames, ...fallback.slice(0, remainingCandidates)];
    if (candidates.length > Math.max(0, MAX_FRAMES_PER_OBSERVATION - ordered.length)) truncated = true;
    for (const child of candidates) {
      if (ordered.length >= MAX_FRAMES_PER_OBSERVATION) break;
      await visit(child, [...path, id]);
    }
  };
  await visit(page.mainFrame(), []);
  return { entries: ordered, truncated };
}

async function frameTransform(frame: Frame): Promise<{ x: number; y: number; scaleX: number; scaleY: number }> {
  if (!frame.parentFrame()) return { x: 0, y: 0, scaleX: 1, scaleY: 1 };
  const element = await frame.frameElement();
  try {
    const [box, metrics] = await Promise.all([
      element.boundingBox(),
      element.evaluate((node) => {
        const html = node as HTMLElement;
        return { clientLeft: html.clientLeft, clientTop: html.clientTop, offsetWidth: html.offsetWidth, offsetHeight: html.offsetHeight };
      }),
    ]);
    if (!box || metrics.offsetWidth <= 0 || metrics.offsetHeight <= 0)
      throw new Error("frame element has no stable box");
    const scaleX = box.width / metrics.offsetWidth, scaleY = box.height / metrics.offsetHeight;
    return { x: box.x + metrics.clientLeft * scaleX, y: box.y + metrics.clientTop * scaleY, scaleX, scaleY };
  } finally {
    await element.dispose();
  }
}

async function frameChainObscured(frame: Frame): Promise<boolean> {
  let child = frame;
  while (child.parentFrame()) {
    const element = await child.frameElement();
    try {
      const obscured = await element.evaluate((node) => {
        const rect = (node as Element).getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && hit !== node && !node.contains(hit) && !hit.contains(node));
      });
      if (obscured) return true;
    } finally {
      await element.dispose();
    }
    child = child.parentFrame()!;
  }
  return false;
}

async function targetObscuredAcrossFrames(frame: Frame, localPoint: { x: number; y: number }): Promise<boolean> {
  let child = frame, point = localPoint;
  while (child.parentFrame()) {
    point = projectPoint(await frameContentMatrix(child), point);
    const element = await child.frameElement();
    try {
      const obscured = await element.evaluate((node, projected) => {
        const hit = document.elementFromPoint(projected.x, projected.y);
        return Boolean(hit && hit !== node && !node.contains(hit) && !hit.contains(node));
      }, point);
      if (obscured) return true;
    } finally { await element.dispose(); }
    child = child.parentFrame()!;
  }
  return false;
}

export async function collectPageState(
  page: Page,
  options: CollectPageStateOptions = {}
): Promise<PagePerception> {
  // Protocol v1 deliberately keeps its original top-document R# contract.
  if (options.legacyRefs) return collectLegacyPageState(page, options);
  const full = options.full ?? false;
  const maxDepth = bounded(options.depth, DEFAULTS.depth, 50);
  const breadth = bounded(options.breadth, DEFAULTS.breadth, 500);
  const maxChars = bounded(options.maxChars, DEFAULTS.maxChars, 100_000);
  // Normalize away undefined keys: the scope object is recorded on the state
  // snapshot and embedded in typed error details, which must stay JSON-safe.
  const scope =
    options.scope && (options.scope.ref || options.scope.within)
      ? {
          ...(options.scope.ref ? { ref: options.scope.ref } : {}),
          ...(options.scope.within ? { within: options.scope.within } : {}),
        }
      : undefined;
  // Refs arrive in scoped `F#:R#` (or bare `R#`) form; the realm registry is
  // keyed by the local `R#` part, so parse before the in-page lookup.
  let realmScope: { ref?: string; within?: string } | undefined = scope;
  if (scope?.ref) {
    const parsedRef = parseScopedRef(scope.ref);
    if (!parsedRef)
      throw new AgentProtocolError("TARGET_MISSING", `Scope ref "${scope.ref}" is invalid`, true, {
        details: { ref: scope.ref },
      });
    if (parsedRef.frameId !== "F0")
      throw new AgentProtocolError(
        "UNSUPPORTED_CONTEXT",
        `Scoped observation only supports top-document refs; "${scope.ref}" targets frame ${parsedRef.frameId}`,
        false,
        { details: { ref: scope.ref, frameId: parsedRef.frameId } }
      );
    realmScope = { ref: parsedRef.localRef };
  }
  const initialTop = await page.mainFrame().evaluate(collectRealm, {
    full,
    legacyRefs: false,
    maxRecords: MAX_RECORDS_PER_OBSERVATION,
    maxWork: MAX_WORK_PER_FRAME,
    scope: realmScope,
    textOnly: options.textOnly ?? false,
    textMaxChars: maxChars,
  });
  if (scope) {
    const scopeLabel = scope.within ?? scope.ref ?? "";
    if (initialTop.scope?.ambiguous)
      throw new AgentProtocolError(
        "AMBIGUOUS_TARGET",
        `Scope "${scopeLabel}" matched ${initialTop.scope.count} elements; refine with role: or name:`,
        true,
        { details: { scope } }
      );
    if (initialTop.scope && !initialTop.scope.matched)
      throw new AgentProtocolError(
        "TARGET_MISSING",
        `No element matched scope "${scopeLabel}"`,
        true,
        { details: { scope } }
      );
  }
  beginFrameGeneration(page, initialTop.realmToken);
  // A resolved content scope is document-scoped (main/aside/dialog/ref), not
  // frame-scoped: restrict collection to the top frame so budgets are spent
  // only inside the selected subtree instead of also walking every iframe.
  const selectedFrames = scope
    ? { entries: [{ frame: page.mainFrame(), id: "F0", path: ["F0"] }], truncated: false }
    : await deterministicFrames(page);
  const frames = selectedFrames.entries;
  const warnings: string[] = ["Closed shadow roots cannot be inspected; observation covers light DOM and open shadow roots only"];
  const registered: RegisteredFrame[] = [];
  const records: PerceptionElement[] = [];
  let top: Awaited<ReturnType<typeof collectRealm>> | undefined;
  let collectionTruncated = selectedFrames.truncated;
  for (const entry of frames) {
    try {
      const [raw, matrix, inheritedVisible] = await Promise.all([
        entry.id === "F0" ? Promise.resolve(initialTop) : entry.frame.evaluate(collectRealm, { full, legacyRefs: false, maxRecords: Math.max(0, MAX_RECORDS_PER_OBSERVATION - records.length), maxWork: MAX_WORK_PER_FRAME }),
        frameToTopMatrix(entry.frame),
        frameAncestorsVisible(entry.frame),
      ]);
      if (entry.id === "F0") top = raw;
      registered.push({ id: entry.id, frame: entry.frame, realmToken: raw.realmToken, path: entry.path, url: raw.url.slice(0, 500), name: entry.frame.name().slice(0, 100) });
      collectionTruncated ||= raw.truncated;
      for (const record of raw.records) {
        if (records.length >= MAX_RECORDS_PER_OBSERVATION) { collectionTruncated = true; break; }
        const ref = record.ref && entry.id !== "F0" ? `${entry.id}:${record.ref}` : record.ref;
        const projected = projectRect(matrix, record.box);
        const box = inheritedVisible ? projected.box : { x: 0, y: 0, width: 0, height: 0 };
        const frameObscured = inheritedVisible && entry.id !== "F0" && record.actionable && record.visible
          ? await targetObscuredAcrossFrames(entry.frame, { x: record.box.x + record.box.width / 2, y: record.box.y + record.box.height / 2 }) : false;
        const topViewport = top?.viewport ?? page.viewportSize() ?? raw.viewport;
        records.push({
          ...record,
          ref,
          box,
          quad: projected.quad,
          visible: inheritedVisible && record.visible,
          actionable: inheritedVisible && record.actionable,
          scrollable: inheritedVisible && record.scrollable,
          obscured: record.obscured || frameObscured,
          inViewport: inheritedVisible && record.visible && box.x + box.width >= 0 && box.y + box.height >= 0 && box.x <= topViewport.width && box.y <= topViewport.height,
          frameId: entry.id,
          framePath: entry.path,
          frameUrl: raw.url.slice(0, 500),
          frameName: entry.frame.name().slice(0, 100),
          frameDocumentId: raw.realmToken.slice(0, 100),
        });
      }
    } catch (error) {
      if (entry.id === "F0") throw error;
      warnings.push(`Frame ${entry.id} could not be inspected because it detached, navigated, or became inaccessible`);
    }
  }
  if (!top) throw new AgentProtocolError("PAGE_CLOSED", "Top document could not be inspected", true);
  if (selectedFrames.truncated)
    warnings.push(`Frame candidate scan was truncated at ${MAX_FRAME_CANDIDATE_SCAN} direct children before inspection`);
  registerFrames(page, top.realmToken, registered);
  const maxNodes = bounded(options.maxNodes, DEFAULTS.maxNodes, 1_000);
  const offset = decodeCursor(options.continuation);
  if (offset > records.length)
    throw new AgentProtocolError("STALE_STATE", "Invalid or expired continuation cursor", true, { nextCommands: ["dev-browser observe"] });
  const built = buildCompactTree(records, maxNodes, maxChars, offset, maxDepth, breadth);
  const history = recordPageState(page, top.realmToken, options.track ?? "default", {
    url: top.url, title: top.title,
    focusedRef: records.find((record) => record.focused)?.ref || null,
    elements: records,
    scope,
  }, options.delta ?? false);
  const viewport = top.viewport;
  const coordinate = await page.evaluate(() => ({ devicePixelRatio, scroll: { x: scrollX, y: scrollY } }));
  return {
    documentId: history.documentId, stateId: history.stateId, url: top.url, title: top.title,
    coordinateSpace: { unit: "css-px", viewport, devicePixelRatio: coordinate.devicePixelRatio, scroll: coordinate.scroll, screenshotScale: "css" },
    focusedRef: records.find((record) => record.focused)?.ref || null,
    tree: built.tree, elements: built.elements, delta: history.delta, warnings: warnings.slice(0, 20),
    truncation: { truncated: built.omittedNodes > 0 || collectionTruncated, omittedNodes: built.omittedNodes + (collectionTruncated ? 1 : 0), continuation: built.omittedNodes > 0 ? encodeCursor(offset + built.consumedNodes) : null },
    scope: scope
      ? { kind: scope.ref ? "ref" : "within", value: scope.ref ?? scope.within ?? "", frameId: "F0" }
      : null,
    textOnly:
      options.textOnly && top.text
        ? { text: top.text.text, truncation: { truncated: top.text.truncated, chars: top.text.text.length, maxChars } }
        : undefined,
  };
}
