import type { Frame, Page } from "playwright";

import { AgentProtocolError } from "../agent-protocol.js";
import { beginFrameGeneration, parseScopedRef, registerFrames, stableFrameId, type RegisteredFrame } from "../frame-registry.js";
import { cacheFrameGeometry, composeAffine, projectPoint, projectRect } from "../frame-geometry.js";
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
  reuseIfEpoch?: number;
  verbose?: boolean;
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

export type CompactPerceptionElement = Pick<PerceptionElement, "ref" | "role" | "box"> &
  Partial<
    Pick<
      PerceptionElement,
      | "name"
      | "landmark"
      | "disabled"
      | "checked"
      | "expanded"
      | "selected"
      | "pressed"
      | "scrollable"
      | "obscured"
      | "focused"
      | "inViewport"
      | "frameId"
      | "value"
      | "placeholder"
      | "inputType"
    >
  > & {
    stableAttributes?: Partial<PerceptionElement["stableAttributes"]>;
  };

/** Project collected state onto the opt-in compact v2 wire format. */
export function compactElement(element: PerceptionElement): CompactPerceptionElement {
  const compact: CompactPerceptionElement = {
    ref: element.ref,
    role: element.role,
    box: {
      x: Math.round(element.box.x),
      y: Math.round(element.box.y),
      width: Math.round(element.box.width),
      height: Math.round(element.box.height),
    },
  };
  if (element.name) compact.name = element.name;
  if (element.landmark) compact.landmark = element.landmark.replace(/\s*>\s*/g, ">");
  for (const key of ["disabled", "scrollable", "obscured", "focused"] as const) {
    if (element[key]) compact[key] = true;
  }
  for (const key of ["checked", "expanded", "selected", "pressed"] as const) {
    if (element[key] != null) Object.assign(compact, { [key]: element[key] });
  }
  if (!element.inViewport) compact.inViewport = false;
  if (element.frameId && element.frameId !== "F0") compact.frameId = element.frameId;
  if (["textbox", "searchbox", "combobox", "spinbutton"].includes(element.role)) {
    for (const key of ["value", "placeholder", "inputType"] as const) {
      if (element[key]) compact[key] = element[key];
    }
  }
  const attributes = Object.fromEntries(
    Object.entries(element.stableAttributes).filter(
      ([key, value]) => key.trim() && typeof value === "string" && value.trim()
    )
  );
  if (Object.keys(attributes).length) compact.stableAttributes = attributes;
  return compact;
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
  /** Every collected record, bounded only by the hard collection caps (frames,
   * records, per-frame work) — not by the tree display budget. All targetable
   * records are ref-registered in-page, so server-side matching (find) may use
   * this set and still hand out resolvable refs. */
  allElements: PerceptionElement[];
  /** Whether the collection itself hit a hard cap. Distinct from `truncation`,
   * which describes the display-budgeted tree/elements payload. */
  collection: { truncated: boolean };
  delta: PerceptionDelta | null;
  warnings: string[];
  truncation: { truncated: boolean; omittedNodes: number; continuation: string | null };
  scope?: { kind: "ref" | "within"; value: string; frameId: string } | null;
  textOnly?: { text: string; truncation: { truncated: boolean; chars: number; maxChars: number } };
}

const DEFAULTS = { maxNodes: 100, maxChars: 12_000, depth: 12, breadth: 50 };
const MAX_FRAMES_PER_OBSERVATION = 64;
const MAX_RECORDS_PER_OBSERVATION = 2_000;
// Bounds one in-page collectRealm walk. 20k element visits stay in the low
// tens of milliseconds; the previous 5k cap was reachable on ordinary
// LinkedIn-sized documents and silently hid late-DOM content (overflow menus)
// from find, which then honestly — but uselessly — reported budget-exhausted.
const MAX_WORK_PER_FRAME = 20_000;
const perceptionCache = new WeakMap<
  Page,
  Map<string, { realmToken: string; mutationEpoch: number; perception: PagePerception }>
>();

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
    allElements: raw.records as unknown as PerceptionElement[],
    collection: { truncated: false },
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

type FrameLineageEdge = {
  parent: Frame;
  domIndex: number;
  matrix: import("../frame-geometry.js").AffineMatrix;
  parentMutationEpoch: number;
};
type GeometryFrameEntry = {
  frame: Frame;
  id: string;
  path: string[];
  matrix: import("../frame-geometry.js").AffineMatrix;
  inheritedVisible: boolean;
  inheritedObscured: boolean;
  lineage: FrameLineageEdge[];
};
type ChildFrameGeometry = {
  frame: Frame;
  domIndex: number;
  matrix: import("../frame-geometry.js").AffineMatrix;
  visible: boolean;
  obscured: boolean;
  parentMutationEpoch: number;
  label: string;
  skipReason: string;
};
const frameChildrenCache = new WeakMap<
  Frame,
  { mutationEpoch: number; children: ChildFrameGeometry[]; skipped: string[]; truncated: boolean }
>();

async function deterministicFrames(
  page: Page,
  topMutationEpoch: number
): Promise<{ entries: GeometryFrameEntry[]; skipped: string[]; truncated: boolean }> {
  const ordered: GeometryFrameEntry[] = [];
  const skipped: string[] = [];
  let truncated = false;
  const domChildren = async (
    frame: Frame,
    knownMutationEpoch?: number
  ): Promise<{ children: ChildFrameGeometry[]; skipped: string[]; truncated: boolean }> => {
    const mutationEpoch =
      knownMutationEpoch ??
      (await frame
        .evaluate(() =>
          (window as Window & {
            __devBrowserPerceptionState?: { mutationEpoch: number };
          }).__devBrowserPerceptionState?.mutationEpoch ?? -1
        )
        .catch(() => -1));
    const cached = frameChildrenCache.get(frame);
    if (
      mutationEpoch >= 0 &&
      cached?.mutationEpoch === mutationEpoch &&
      cached.children.every((entry) => !entry.frame.isDetached())
    )
      return { children: cached.children, skipped: cached.skipped, truncated: cached.truncated };
    const result = await frame.evaluateHandle(({ maxFrames, maxWork }) => {
      type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
      type Metadata = {
        domIndex: number;
        matrix: Matrix;
        visible: boolean;
        obscured: boolean;
        label: string;
        skipReason: string;
      };
      const elements: Element[] = [], metadata: Metadata[] = [], stack: Element[] = [];
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
        if (element.matches("iframe,frame")) {
          const html = element as HTMLElement;
          const rect = element.getBoundingClientRect();
          let current: Element | null = element;
          let opacity = 1;
          let visible = rect.width > 0 && rect.height > 0;
          let clipLeft = rect.left, clipTop = rect.top, clipRight = rect.right, clipBottom = rect.bottom;
          for (let depth = 0; visible && current && depth < 100; depth += 1) {
            const currentStyle = getComputedStyle(current);
            if (
              currentStyle.display === "none" ||
              currentStyle.visibility === "hidden" ||
              currentStyle.visibility === "collapse" ||
              currentStyle.contentVisibility === "hidden"
            ) {
              visible = false;
              break;
            }
            const localOpacity = Number.parseFloat(currentStyle.opacity || "1");
            opacity *= Number.isFinite(localOpacity) ? localOpacity : 1;
            if (opacity <= 0.001) {
              visible = false;
              break;
            }
            const currentRect = current.getBoundingClientRect();
            if (
              currentStyle.display !== "contents" &&
              [currentStyle.overflow, currentStyle.overflowX, currentStyle.overflowY].some((value) =>
                /hidden|clip|scroll|auto/.test(value)
              )
            ) {
              clipLeft = Math.max(clipLeft, currentRect.left);
              clipTop = Math.max(clipTop, currentRect.top);
              clipRight = Math.min(clipRight, currentRect.right);
              clipBottom = Math.min(clipBottom, currentRect.bottom);
              if (clipRight <= clipLeft || clipBottom <= clipTop) visible = false;
            }
            const root = current.getRootNode();
            current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
          }
          const nearViewport =
            rect.bottom >= -2 * innerHeight &&
            rect.top <= 3 * innerHeight &&
            rect.right >= -2 * innerWidth &&
            rect.left <= 3 * innerWidth;
          const skipReason = !visible
            ? rect.width <= 0 || rect.height <= 0
              ? "zero-size"
              : "hidden"
            : !nearViewport
              ? "more than two viewports away"
              : "";
          visible &&= nearViewport;
          const style = getComputedStyle(element);
          const parsed = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
          const origin = style.transformOrigin.split(/\s+/).map((value) => Number.parseFloat(value));
          const ox = origin[0] || 0, oy = origin[1] || 0;
          const baseE = parsed.e + ox - parsed.a * ox - parsed.c * oy;
          const baseF = parsed.f + oy - parsed.b * ox - parsed.d * oy;
          const points = [
            [0, 0],
            [html.offsetWidth, 0],
            [html.offsetWidth, html.offsetHeight],
            [0, html.offsetHeight],
          ].map(([x, y]) => ({
            x: parsed.a * x! + parsed.c * y! + baseE,
            y: parsed.b * x! + parsed.d * y! + baseF,
          }));
          const shiftX = rect.left - Math.min(...points.map((point) => point.x));
          const shiftY = rect.top - Math.min(...points.map((point) => point.y));
          const matrix = {
            a: parsed.a,
            b: parsed.b,
            c: parsed.c,
            d: parsed.d,
            e: baseE + shiftX + parsed.a * html.clientLeft + parsed.c * html.clientTop,
            f: baseF + shiftY + parsed.b * html.clientLeft + parsed.d * html.clientTop,
          };
          const hit = visible
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
          const obscured = Boolean(
            hit && hit !== element && !element.contains(hit) && !hit.contains(element)
          );
          const domIndex = elements.length;
          elements.push(element);
          metadata.push({
            domIndex,
            matrix,
            visible,
            obscured,
            label: (
              element.getAttribute("title") ||
              element.getAttribute("name") ||
              element.id ||
              `frame-${domIndex + 1}`
            ).replace(/\s+/g, " ").trim().slice(0, 100),
            skipReason,
          });
        }
        const remaining = Math.max(0, maxWork - work - stack.length);
        const lightCount = Math.min(element.children.length, remaining);
        const shadow = element.shadowRoot?.children;
        const shadowCount = Math.min(shadow?.length ?? 0, remaining - lightCount);
        if (lightCount < element.children.length || shadowCount < (shadow?.length ?? 0)) wasTruncated = true;
        for (let index = shadowCount - 1; index >= 0; index -= 1) stack.push(shadow!.item(index)!);
        for (let index = lightCount - 1; index >= 0; index -= 1) stack.push(element.children.item(index)!);
      }
      if (stack.length > 0 || elements.length >= maxFrames) wasTruncated = true;
      return { elements, metadata, truncated: wasTruncated };
    }, { maxFrames: MAX_FRAME_CANDIDATE_SCAN, maxWork: 1_000 });
    try {
      const truncatedHandle = await result.getProperty("truncated");
      const wasTruncated = await truncatedHandle.jsonValue() as boolean;
      await truncatedHandle.dispose();
      const metadataHandle = await result.getProperty("metadata");
      const metadata = await metadataHandle.jsonValue() as Array<Omit<ChildFrameGeometry, "frame">>;
      await metadataHandle.dispose();
      const elementsHandle = await result.getProperty("elements");
      try {
        const properties = await elementsHandle.getProperties();
        const children: ChildFrameGeometry[] = [];
        const skippedFrames: string[] = [];
        for (let index = 0; index < MAX_FRAME_CANDIDATE_SCAN; index += 1) {
          const handle = properties.get(String(index))?.asElement();
          if (!handle) break;
          const geometry = metadata[index];
          if (geometry && !geometry.visible) {
            skippedFrames.push(`${geometry.label} (${geometry.skipReason})`);
            await handle.dispose();
            continue;
          }
          const child = await handle.contentFrame();
          if (child && geometry)
            children.push({ frame: child, ...geometry, parentMutationEpoch: mutationEpoch });
          await handle.dispose();
        }
        if (mutationEpoch >= 0)
          frameChildrenCache.set(frame, { mutationEpoch, children, skipped: skippedFrames, truncated: wasTruncated });
        return { children, skipped: skippedFrames, truncated: wasTruncated };
      } finally { await elementsHandle.dispose(); }
    } finally { await result.dispose(); }
  };
  const visit = async (entry: GeometryFrameEntry, knownMutationEpoch?: number) => {
    if (ordered.length >= MAX_FRAMES_PER_OBSERVATION) return;
    ordered.push(entry);
    const selected = await domChildren(entry.frame, knownMutationEpoch);
    truncated ||= selected.truncated;
    skipped.push(...selected.skipped);
    const candidates = selected.children.filter((child) => child.visible && !child.frame.isDetached());
    if (candidates.length > Math.max(0, MAX_FRAMES_PER_OBSERVATION - ordered.length))
      truncated = true;
    for (const child of candidates) {
      if (ordered.length >= MAX_FRAMES_PER_OBSERVATION) break;
      const id = stableFrameId(page, child.frame);
      const matrixToTop = composeAffine(entry.matrix, child.matrix);
      const ancestorsVisible = entry.inheritedVisible && child.visible;
      cacheFrameGeometry(child.frame, {
        parent: entry.frame,
        parentMutationEpoch: child.parentMutationEpoch,
        dependencies: [
          ...entry.lineage.map((edge) => ({
            parent: edge.parent,
            mutationEpoch: edge.parentMutationEpoch,
          })),
          { parent: entry.frame, mutationEpoch: child.parentMutationEpoch },
        ],
        contentMatrix: child.matrix,
        matrixToTop,
        ancestorsVisible,
      });
      await visit({
        frame: child.frame,
        id,
        path: [...entry.path, id],
        matrix: matrixToTop,
        inheritedVisible: ancestorsVisible,
        inheritedObscured: entry.inheritedObscured || child.obscured,
        lineage: [...entry.lineage, {
          parent: entry.frame,
          domIndex: child.domIndex,
          matrix: child.matrix,
          parentMutationEpoch: child.parentMutationEpoch,
        }],
      });
    }
  };
  await visit({
    frame: page.mainFrame(),
    id: "F0",
    path: ["F0"],
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    inheritedVisible: true,
    inheritedObscured: false,
    lineage: [],
  }, topMutationEpoch);
  return { entries: ordered, skipped, truncated };
}

async function batchedTargetObstructions(
  pending: Array<{
    recordIndex: number;
    lineage: FrameLineageEdge[];
    localPoint: { x: number; y: number };
  }>
): Promise<Set<number>> {
  const grouped = new Map<
    Frame,
    Array<{ recordIndex: number; domIndex: number; point: { x: number; y: number } }>
  >();
  for (const target of pending) {
    let point = target.localPoint;
    for (let index = target.lineage.length - 1; index >= 0; index -= 1) {
      const edge = target.lineage[index]!;
      point = projectPoint(edge.matrix, point);
      const requests = grouped.get(edge.parent) ?? [];
      requests.push({ recordIndex: target.recordIndex, domIndex: edge.domIndex, point });
      grouped.set(edge.parent, requests);
    }
  }
  const obscured = new Set<number>();
  await Promise.all(
    [...grouped].map(async ([parent, requests]) => {
      if (parent.isDetached()) return;
      const results = await parent
        .evaluate((checks) => {
          const elements: Element[] = [], stack: Element[] = [];
          const pushReverse = (children: HTMLCollection) => {
            for (let index = children.length - 1; index >= 0; index -= 1)
              stack.push(children.item(index)!);
          };
          pushReverse(document.documentElement?.children ?? document.children);
          let work = 0;
          while (stack.length > 0 && work < 1_000 && elements.length < 128) {
            const element = stack.pop()!;
            work += 1;
            if (element.matches("iframe,frame")) elements.push(element);
            const shadow = element.shadowRoot?.children;
            if (shadow) pushReverse(shadow);
            pushReverse(element.children);
          }
          return checks.map(({ recordIndex, domIndex, point }) => {
            const element = elements[domIndex];
            const hit = document.elementFromPoint(point.x, point.y);
            return {
              recordIndex,
              obscured: Boolean(
                !element ||
                (hit && hit !== element && !element.contains(hit) && !hit.contains(element))
              ),
            };
          });
        }, requests)
        .catch(() => requests.map(({ recordIndex }) => ({ recordIndex, obscured: true })));
      for (const result of results) if (result.obscured) obscured.add(result.recordIndex);
    })
  );
  return obscured;
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
  const cacheKey = JSON.stringify({
    full,
    maxDepth,
    breadth,
    maxChars,
    maxNodes: bounded(options.maxNodes, DEFAULTS.maxNodes, 1_000),
    scope: scope ?? null,
    textOnly: options.textOnly ?? false,
    verbose: options.verbose ?? false,
  });
  if (options.reuseIfEpoch !== undefined && !options.continuation) {
    const cached = perceptionCache.get(page)?.get(cacheKey);
    if (cached && cached.mutationEpoch === options.reuseIfEpoch) {
      const signal = await page.mainFrame().evaluate(() => {
        const state = (window as Window & {
          __devBrowserPerceptionState?: {
            token: string;
            mutationEpoch: number;
            refs: WeakMap<Element, string>;
          };
        }).__devBrowserPerceptionState;
        let active: Element | null = document.activeElement;
        while (active instanceof HTMLElement && active.shadowRoot?.activeElement)
          active = active.shadowRoot.activeElement;
        return {
          realmToken: state?.token ?? "",
          mutationEpoch: state?.mutationEpoch ?? -1,
          activeRef: active && state ? state.refs.get(active) ?? null : null,
          url: location.href,
          title: document.title,
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          scroll: { x: scrollX, y: scrollY },
        };
      });
      if (
        signal.realmToken === cached.realmToken &&
        signal.mutationEpoch === options.reuseIfEpoch
      ) {
        const records = cached.perception.allElements.map((element) => ({
          ...element,
          focused: element.frameId === "F0" && element.ref === signal.activeRef,
        }));
        const maxNodes = bounded(options.maxNodes, DEFAULTS.maxNodes, 1_000);
        const built = buildCompactTree(records, maxNodes, maxChars, 0, maxDepth, breadth);
        const history = recordPageState(page, signal.realmToken, options.track ?? "default", {
          url: signal.url,
          title: signal.title,
          mutationEpoch: signal.mutationEpoch,
          focusedRef: signal.activeRef,
          elements: records,
          scope,
        }, options.delta ?? false);
        const reused: PagePerception = {
          ...cached.perception,
          documentId: history.documentId,
          stateId: history.stateId,
          url: signal.url,
          title: signal.title,
          coordinateSpace: {
            unit: "css-px",
            viewport: signal.viewport,
            devicePixelRatio: signal.devicePixelRatio,
            scroll: signal.scroll,
            screenshotScale: "css",
          },
          focusedRef: signal.activeRef,
          tree: built.tree,
          elements: built.elements,
          allElements: records,
          delta: history.delta,
          truncation: {
            truncated: built.omittedNodes > 0 || cached.perception.collection.truncated,
            omittedNodes: built.omittedNodes + (cached.perception.collection.truncated ? 1 : 0),
            continuation: built.omittedNodes > 0 ? encodeCursor(built.consumedNodes) : null,
          },
        };
        perceptionCache.get(page)!.set(cacheKey, {
          realmToken: signal.realmToken,
          mutationEpoch: signal.mutationEpoch,
          perception: reused,
        });
        return reused;
      }
    }
  }
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
    if (initialTop.scope?.ambiguous) {
      // Tailor the refinement advice to what the caller already tried: telling
      // someone who passed role:menu to "refine with role:" is a dead end.
      const advice = scopeLabel.startsWith("role:")
        ? "use name:<exact name>, or pick one element from find/observe and scope by --root REF"
        : scopeLabel.startsWith("name:")
          ? "pick one element from find/observe and scope by --root REF"
          : "refine with role: or name:, or scope by --root REF";
      throw new AgentProtocolError(
        "AMBIGUOUS_TARGET",
        `Scope "${scopeLabel}" matched ${initialTop.scope.count} elements; ${advice}`,
        true,
        { details: { scope } }
      );
    }
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
    ? {
        entries: [{
          frame: page.mainFrame(),
          id: "F0",
          path: ["F0"],
          matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
          inheritedVisible: true,
          inheritedObscured: false,
          lineage: [],
        } satisfies GeometryFrameEntry],
        skipped: [],
        truncated: false,
      }
    : await deterministicFrames(page, initialTop.mutationEpoch);
  const frames = selectedFrames.entries;
  const warnings: string[] = [];
  const registered: RegisteredFrame[] = [];
  const records: PerceptionElement[] = [];
  const pendingFrameHitTests: Array<{
    recordIndex: number;
    lineage: FrameLineageEdge[];
    localPoint: { x: number; y: number };
  }> = [];
  let top: Awaited<ReturnType<typeof collectRealm>> | undefined;
  let collectionTruncated = selectedFrames.truncated;
  for (const entry of frames) {
    try {
      const raw = await (entry.id === "F0"
        ? Promise.resolve(initialTop)
        : entry.frame.evaluate(collectRealm, {
            full,
            legacyRefs: false,
            maxRecords: Math.max(0, MAX_RECORDS_PER_OBSERVATION - records.length),
            maxWork: MAX_WORK_PER_FRAME,
          }));
      if (entry.id === "F0") top = raw;
      registered.push({ id: entry.id, frame: entry.frame, realmToken: raw.realmToken, path: entry.path, url: raw.url.slice(0, 500), name: entry.frame.name().slice(0, 100) });
      collectionTruncated ||= raw.truncated;
      for (const record of raw.records) {
        if (records.length >= MAX_RECORDS_PER_OBSERVATION) { collectionTruncated = true; break; }
        const ref = record.ref && entry.id !== "F0" ? `${entry.id}:${record.ref}` : record.ref;
        const projected = projectRect(entry.matrix, record.box);
        const box = entry.inheritedVisible ? projected.box : { x: 0, y: 0, width: 0, height: 0 };
        const topViewport = top?.viewport ?? page.viewportSize() ?? raw.viewport;
        const inViewport =
          entry.inheritedVisible &&
          record.visible &&
          box.x + box.width >= 0 &&
          box.y + box.height >= 0 &&
          box.x <= topViewport.width &&
          box.y <= topViewport.height;
        const recordIndex = records.length;
        records.push({
          ...record,
          ref,
          box,
          quad: projected.quad,
          visible: entry.inheritedVisible && record.visible,
          actionable: entry.inheritedVisible && record.actionable,
          scrollable: entry.inheritedVisible && record.scrollable,
          obscured: record.obscured || entry.inheritedObscured,
          inViewport,
          frameId: entry.id,
          framePath: entry.path,
          frameUrl: raw.url.slice(0, 500),
          frameName: entry.frame.name().slice(0, 100),
          frameDocumentId: raw.realmToken.slice(0, 100),
        });
        if (
          entry.id !== "F0" &&
          entry.lineage.length > 0 &&
          record.actionable &&
          record.visible &&
          inViewport
        )
          pendingFrameHitTests.push({
            recordIndex,
            lineage: entry.lineage,
            localPoint: {
              x: record.box.x + record.box.width / 2,
              y: record.box.y + record.box.height / 2,
            },
          });
      }
    } catch (error) {
      if (entry.id === "F0") throw error;
      warnings.push(`Frame ${entry.id} could not be inspected because it detached, navigated, or became inaccessible`);
    }
  }
  const crossFrameObstructions = await batchedTargetObstructions(pendingFrameHitTests);
  for (const recordIndex of crossFrameObstructions) {
    const record = records[recordIndex];
    if (record) record.obscured = true;
  }
  if (!top) throw new AgentProtocolError("PAGE_CLOSED", "Top document could not be inspected", true);
  if (selectedFrames.truncated)
    warnings.push(`Frame candidate scan was truncated at ${MAX_FRAME_CANDIDATE_SCAN} direct children before inspection`);
  if (options.verbose && selectedFrames.skipped.length > 0)
    warnings.push(
      `Skipped hidden, zero-size, or distant frames: ${selectedFrames.skipped.slice(0, 20).join(", ")}`
    );
  registerFrames(page, top.realmToken, registered);
  const maxNodes = bounded(options.maxNodes, DEFAULTS.maxNodes, 1_000);
  const offset = decodeCursor(options.continuation);
  if (offset > records.length)
    throw new AgentProtocolError("STALE_STATE", "Invalid or expired continuation cursor", true, { nextCommands: ["dev-browser observe"] });
  const built = buildCompactTree(records, maxNodes, maxChars, offset, maxDepth, breadth);
  const history = recordPageState(page, top.realmToken, options.track ?? "default", {
    url: top.url, title: top.title, mutationEpoch: top.mutationEpoch,
    focusedRef: records.find((record) => record.focused)?.ref || null,
    elements: records,
    scope,
  }, options.delta ?? false);
  const viewport = top.viewport;
  const coordinate = await page.evaluate(() => ({ devicePixelRatio, scroll: { x: scrollX, y: scrollY } }));
  const perception: PagePerception = {
    documentId: history.documentId, stateId: history.stateId, url: top.url, title: top.title,
    coordinateSpace: { unit: "css-px", viewport, devicePixelRatio: coordinate.devicePixelRatio, scroll: coordinate.scroll, screenshotScale: "css" },
    focusedRef: records.find((record) => record.focused)?.ref || null,
    tree: built.tree, elements: built.elements, allElements: records, collection: { truncated: collectionTruncated }, delta: history.delta, warnings: warnings.slice(0, 20),
    truncation: { truncated: built.omittedNodes > 0 || collectionTruncated, omittedNodes: built.omittedNodes + (collectionTruncated ? 1 : 0), continuation: built.omittedNodes > 0 ? encodeCursor(offset + built.consumedNodes) : null },
    scope: scope
      ? { kind: scope.ref ? "ref" : "within", value: scope.ref ?? scope.within ?? "", frameId: "F0" }
      : null,
    textOnly:
      options.textOnly && top.text
        ? { text: top.text.text, truncation: { truncated: top.text.truncated, chars: top.text.text.length, maxChars } }
        : undefined,
  };
  let pageCache = perceptionCache.get(page);
  if (!pageCache) {
    pageCache = new Map();
    perceptionCache.set(page, pageCache);
  }
  pageCache.set(cacheKey, {
    realmToken: top.realmToken,
    mutationEpoch: top.mutationEpoch,
    perception,
  });
  return perception;
}
