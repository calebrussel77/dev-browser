import type { Page } from "playwright";

import { AgentProtocolError } from "../agent-protocol.js";
import { recordPageState, type PerceptionDelta } from "../page-state.js";
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
}

export interface PerceptionElement {
  ref: string;
  role: string;
  name: string;
  description: string;
  landmark: string;
  semanticAncestors: string[];
  box: { x: number; y: number; width: number; height: number };
  visible: boolean;
  inViewport: boolean;
  actionable: boolean;
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
  focused: boolean;
  nearby: { heading: string; label: string; context: string };
  frameId: "F0";
  shadowContext: [];
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
}

const DEFAULTS = { maxNodes: 100, maxChars: 12_000, depth: 12, breadth: 50 };

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

export async function collectPageState(
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
  const built = buildCompactTree(raw.records, maxNodes, maxChars, offset, maxDepth, breadth);
  const omittedNodes = built.omittedNodes;
  const history = recordPageState(
    page,
    raw.realmToken,
    options.track ?? "default",
    {
      url: raw.url,
      title: raw.title,
      focusedRef: raw.focusedRef,
      elements: raw.records,
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
