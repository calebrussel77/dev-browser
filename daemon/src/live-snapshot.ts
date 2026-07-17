import type { Frame, Page } from "playwright";

import { frameAncestorsVisible } from "./frame-geometry.js";
import { parseScopedRef, registeredFrame, registeredFrames } from "./frame-registry.js";

const MAX_FRAMES = 64;
const MAX_RECORDS = 2_000;
const MAX_TEXT = 10_000;
const MAX_WORK = 1_000;
const MAX_DEPTH = 100;

export interface LiveRefState {
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  value: string;
  attributes: Record<string, string | null>;
  states: Record<string, string>;
  frameId: string;
  shadowContext: string[];
}

export interface LivePageSnapshot {
  dialogs: string[];
  toasts: string[];
  bodyText: string[];
  refs: Record<string, LiveRefState>;
  frameSignals: Array<{ frameId: string; url: string; dom: string; focus: string; values: string[] }>;
  truncated: boolean;
  hiddenFrameIds: string[];
}

type LiveFrame = { id: string; frame: Frame; ancestorsVisible: boolean };

async function liveFrames(page: Page): Promise<{ frames: LiveFrame[]; truncated: boolean }> {
  const registered = registeredFrames(page);
  const candidates = registered.length > 0
    ? registered.map(({ id, frame }) => ({ id, frame }))
    : [{ id: "F0", frame: page.mainFrame() }];
  const frames: LiveFrame[] = [];
  let truncated = candidates.length > MAX_FRAMES;
  for (let index = 0; index < Math.min(candidates.length, MAX_FRAMES); index += 1) {
    const entry = candidates[index]!;
    if (entry.frame.isDetached()) continue;
    const visible = await frameAncestorsVisible(entry.frame).catch(() => false);
    frames.push({ ...entry, ancestorsVisible: visible });
  }
  return { frames, truncated };
}

export async function collectLiveSnapshot(page: Page): Promise<LivePageSnapshot> {
  const refs: Record<string, LiveRefState> = {};
  const dialogs: string[] = [], toasts: string[] = [], bodyText: string[] = [], frameSignals: LivePageSnapshot["frameSignals"] = [];
  let recordCount = 0;
  const selected = await liveFrames(page);
  const hiddenFrameIds = selected.frames.filter((entry) => !entry.ancestorsVisible).map((entry) => entry.id);
  let truncated = selected.truncated;
  for (const { frame, id: frameId, ancestorsVisible } of selected.frames) {
    if (!ancestorsVisible) continue;
    try {
      const raw = await frame.evaluate(({ maxRecords, maxText, maxWork, maxDepth }) => {
        type BoundedTextResult = { text: string; truncated: boolean; visited: number };
        type RealmState = { token?: string; refs: WeakMap<Element, string>; boundedText?: (root: Node, maxChars?: number, maxNodes?: number) => BoundedTextResult };
        const state = (window as Window & { __devBrowserPerceptionState?: RealmState }).__devBrowserPerceptionState;
        const boundedText = (root: Node, maxChars = maxText, maxNodes = maxWork): BoundedTextResult => {
          if (state?.boundedText) return state.boundedText(root, maxChars, maxNodes);
          const pending: Node[] = [root]; let text = "", visited = 0, truncated = false;
          while (pending.length > 0 && visited < maxNodes && text.length < maxChars) {
            const current = pending.pop()!; visited += 1;
            if (current.nodeType === Node.TEXT_NODE) { const data = (current as Text).data, remaining = maxChars - text.length; text += data.slice(0, remaining); if (data.length > remaining) truncated = true; continue; }
            const children = current.childNodes, remainingNodes = Math.max(0, maxNodes - visited - pending.length), selected = Math.min(children.length, remainingNodes);
            if (children.length > selected) truncated = true;
            for (let index = selected - 1; index >= 0; index -= 1) pending.push(children.item(index)!);
          }
          if (pending.length > 0) truncated = true;
          return { text: text.replace(/\s+/g, " ").trim(), truncated, visited };
        };
        const rows: Array<{ ref: string; visible: boolean; enabled: boolean; value: string; attributes: Record<string, string | null>; states: Record<string, string>; shadowContext: string[] }> = [];
        const dialogText: string[] = [], toastText: string[] = [], bodyChunks: string[] = [], domParts: string[] = [];
        type Pending = { element: Element; shadowContext: string[]; depth: number };
        const stack: Pending[] = [];
        let work = 0, auxiliaryWork = 0, domChars = 0, wasTruncated = false;
        const pushChildrenReverse = (children: HTMLCollection, shadowContext: string[], depth: number) => {
          const remaining = Math.max(0, maxWork - work - stack.length);
          const selected = Math.min(children.length, remaining);
          if (children.length > selected) wasTruncated = true;
          for (let index = selected - 1; index >= 0; index -= 1)
            stack.push({ element: children.item(index)!, shadowContext, depth });
        };
        pushChildrenReverse(document.documentElement?.children ?? document.children, [], 0);
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
        };
        const compact = (value: string | null | undefined, max = maxText) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        while (stack.length > 0) {
          if (work >= maxWork) { wasTruncated = true; break; }
          const current = stack.pop()!;
          work += 1;
          const { element, shadowContext, depth } = current;
          const ref = state?.refs.get(element);
          let ownRawText = "";
          const childNodeLimit = Math.min(element.childNodes.length, Math.max(0, maxWork - auxiliaryWork));
          auxiliaryWork += childNodeLimit;
          for (let index = 0; index < childNodeLimit && ownRawText.length < maxText; index += 1) {
            const node = element.childNodes.item(index);
            if (node?.nodeType === Node.TEXT_NODE) ownRawText += ` ${(node as Text).data.slice(0, maxText - ownRawText.length)}`;
          }
          if (element.childNodes.length > childNodeLimit) wasTruncated = true;
          const ownText = compact(ownRawText);
          const isDialog = element.matches('[role="dialog"],dialog[open]');
          const isToast = element.matches('[role="status"],[role="alert"],[data-toast],[data-testid*="toast"]');
          const descendant = ref || isDialog || isToast ? boundedText(element) : { text: ownText, truncated: false, visited: 0 };
          if (descendant.truncated) wasTruncated = true;
          if (ownRawText.length > maxText) wasTruncated = true;
          const isVisible = ref || ownText || isDialog || isToast ? visible(element) : true;
          if (domChars < maxText * 4) {
            const part = `${element.tagName}:${ref ?? ""}:${compact(ownRawText, 80)}|`;
            domParts.push(part);
            domChars += part.length;
          }
          if (isVisible) {
            if (ownText && bodyChunks.length < maxWork) bodyChunks.push(ownText);
            else if (ownText) wasTruncated = true;
            if (isDialog && dialogText.length < 20) dialogText.push(descendant.text);
            else if (isDialog) wasTruncated = true;
            if (isToast && toastText.length < 20) toastText.push(descendant.text);
            else if (isToast) wasTruncated = true;
          }
          if (ref) {
            if (rows.length >= maxRecords) { wasTruncated = true; break; }
            const input = element as HTMLInputElement;
            rows.push({ ref, visible: isVisible, enabled: !("disabled" in input) || !input.disabled,
              value: ("value" in input ? String(input.value).slice(0, maxText) : descendant.text),
              attributes: (() => { const attributes: Record<string, string> = {}; for (let index = 0; index < Math.min(element.attributes.length, 30); index += 1) { const attribute = element.attributes.item(index)!; attributes[attribute.name.slice(0, 100)] = attribute.value.slice(0, 500); } return attributes; })(),
              states: { checked: String(Boolean(input.checked)), selected: String(Boolean((element as HTMLOptionElement).selected)), expanded: element.getAttribute("aria-expanded") ?? "", pressed: element.getAttribute("aria-pressed") ?? "" },
              shadowContext: shadowContext.slice(0, 20) });
          }
          if (depth >= maxDepth) {
            if (element.children.length > 0 || element.shadowRoot?.children.length) wasTruncated = true;
            continue;
          }
          const remaining = Math.max(0, maxWork - work - stack.length);
          const lightCount = Math.min(element.children.length, remaining);
          const shadowChildren = element.shadowRoot?.children;
          const shadowCount = Math.min(shadowChildren?.length ?? 0, remaining - lightCount);
          if (lightCount < element.children.length || shadowCount < (shadowChildren?.length ?? 0)) wasTruncated = true;
          for (let index = shadowCount - 1; index >= 0; index -= 1)
            stack.push({ element: shadowChildren!.item(index)!, shadowContext: [...shadowContext, element.tagName.toLowerCase()].slice(0, 20), depth: depth + 1 });
          for (let index = lightCount - 1; index >= 0; index -= 1)
            stack.push({ element: element.children.item(index)!, shadowContext, depth: depth + 1 });
        }
        let active: Element | null = document.activeElement;
        for (let depth = 0; depth < 20 && active instanceof HTMLElement && active.shadowRoot?.activeElement; depth += 1) active = active.shadowRoot.activeElement;
        return { realmToken: state?.token ?? "", rows, dialogs: dialogText, toasts: toastText,
          bodyText: compact(bodyChunks.join(" ")), dom: domParts.join("").slice(0, maxText * 4),
          focus: active && active !== document.body ? `${active.tagName}:${state?.refs.get(active) ?? ""}` : "",
          values: rows.map((row) => `${row.ref}:${row.value}`).slice(0, maxRecords), truncated: wasTruncated || stack.length > 0 };
      }, { maxRecords: Math.max(0, MAX_RECORDS - recordCount), maxText: MAX_TEXT, maxWork: MAX_WORK, maxDepth: MAX_DEPTH });
      const expectedRealm = registeredFrame(page, frameId)?.realmToken;
      const realmMatches = !expectedRealm || expectedRealm === raw.realmToken;
      for (const row of realmMatches ? raw.rows : []) {
        const ref = frameId === "F0" ? row.ref : `${frameId}:${row.ref}`;
        refs[ref] = { attached: true, ...row, frameId };
      }
      recordCount += raw.rows.length;
      dialogs.push(...raw.dialogs); toasts.push(...raw.toasts); bodyText.push(raw.bodyText);
      frameSignals.push({ frameId, url: frame.url().slice(0, 500), dom: raw.dom, focus: raw.focus, values: raw.values });
      truncated ||= raw.truncated || recordCount >= MAX_RECORDS;
      if (recordCount >= MAX_RECORDS) break;
    } catch { /* A concurrent detach is represented by missing scoped refs. */ }
  }
  if (dialogs.length > 50 || toasts.length > 50) truncated = true;
  return { dialogs: dialogs.slice(0, 50), toasts: toasts.slice(0, 50), bodyText: bodyText.slice(0, MAX_FRAMES), refs, frameSignals, truncated, hiddenFrameIds };
}

export async function describeLiveRef(page: Page, ref: string): Promise<string> {
  const scoped = parseScopedRef(ref); if (!scoped) return "";
  const frame = scoped.frameId === "F0" ? page.mainFrame() : registeredFrame(page, scoped.frameId)?.frame;
  if (!frame || frame.isDetached()) return "";
  return frame.evaluate((requestedRef) => {
    type RealmState = { refs: WeakMap<Element, string>; byRef?: Map<string, WeakRef<Element>>; boundedText?: (root: Node, maxChars?: number, maxNodes?: number) => { text: string } };
    const state = (window as Window & { __devBrowserPerceptionState?: RealmState }).__devBrowserPerceptionState;
    const element = state?.byRef?.get(requestedRef)?.deref();
    if (!element || state?.refs.get(element) !== requestedRef || !element.isConnected) return "";
    const input = element as HTMLInputElement;
    return [state?.boundedText?.(element, 1_000, 200).text ?? "", element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("role"), element.closest("form") || element.hasAttribute("type") ? input.type : "", input.value?.slice(0, 500)].filter(Boolean).join(" ").slice(0, 2_000);
  }, scoped.localRef).catch(() => "");
}
