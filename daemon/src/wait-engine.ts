import type {
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
  Request,
  Response,
} from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { collectLiveSnapshot } from "./live-snapshot.js";
import type { WaitCondition, WaitSpec } from "./protocol.js";

const POLL_INTERVAL_MS = 25;
const MAX_OBSERVATION_LENGTH = 160;

type ConditionObservation = {
  condition: WaitCondition;
  passed: boolean;
  observed?: string | number | boolean | null;
  coverage?: "complete" | "truncated";
};

export interface WaitEvents {
  requests: Array<{ url: string; method: string }>;
  mutations: Array<{ type: string; target: string; attribute?: string }>;
  focusChanges: Array<{ type: string; target: string }>;
  valueChanges: Array<{ type: string; target: string; property?: string }>;
  dialogs: Array<{ type: string; message: string }>;
  popup: Array<{
    targetId?: string;
    url: string;
    title: string;
    opener: string;
    warning?: string;
  }>;
  download: Array<{ url: string; suggestedFilename: string }>;
  fileChooser: Array<{ multiple: boolean }>;
  navigation: Array<{ url: string; document: boolean }>;
  responses: Array<{ url: string; method: string; status: number }>;
  failedRequests: Array<{ url: string; method: string; failure: string | null }>;
}

type TransientCapture = Pick<WaitEvents, "mutations" | "focusChanges" | "valueChanges">;

export interface WaitResult {
  mode: WaitSpec["mode"];
  elapsedMs: number;
  passed: WaitCondition[];
  timedOut: WaitCondition[];
  observations: ConditionObservation[];
  events: WaitEvents;
}

export interface WaitStateContext<State> {
  collect(): Promise<State>;
  protocolVersion?: 1 | 2;
  onPopup?: (popup: Page) => void;
  onDownload?: (download: Download) => void;
  popupMetadata?: (
    popup: Page,
    signal: AbortSignal
  ) => Promise<{ targetId?: string; url?: string; title?: string }>;
}

const capturedEventsByError = new WeakMap<object, WaitEvents>();

export function capturedWaitEvents(error: unknown): WaitEvents | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? capturedEventsByError.get(error as object)
    : undefined;
}

const POPUP_METADATA_TIMEOUT_MS = 500;

function bounded(value: string): string {
  return value.length <= MAX_OBSERVATION_LENGTH
    ? value
    : `${value.slice(0, MAX_OBSERVATION_LENGTH - 3)}...`;
}

const SENSITIVE_LABEL = /token|auth|key|password|secret|session|code|credential/i;

function sensitiveUrlValues(value: string): string[] {
  try {
    const parsed = new URL(value);
    const values = new Set<string>();
    const collect = (params: URLSearchParams) => {
      for (const [key, candidate] of params.entries())
        if (SENSITIVE_LABEL.test(key) && candidate.length >= 3)
          values.add(candidate.slice(0, MAX_OBSERVATION_LENGTH));
    };
    collect(parsed.searchParams);
    collect(new URLSearchParams(parsed.hash.replace(/^#/, "")));
    return [...values].sort((left, right) => right.length - left.length);
  } catch {
    return [];
  }
}

function replaceSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) => current.split(secret).join("[redacted]"),
    value
  );
}

function safeUrl(value: string, secrets: string[] = []): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "[redacted]";
    if (parsed.password) parsed.password = "[redacted]";
    for (const key of parsed.searchParams.keys()) {
      const value = parsed.searchParams.get(key) ?? "";
      if (
        SENSITIVE_LABEL.test(key) ||
        /(?:token|auth|key|password|secret|session|code|credential)\s*[:=]/i.test(value)
      )
        parsed.searchParams.set(key, "[redacted]");
    }
    if (/(?:token|auth|key|password|secret|session|code|credential)[=:]/i.test(parsed.hash))
      parsed.hash = "#[redacted]";
    return bounded(replaceSecrets(parsed.toString(), secrets));
  } catch {
    return bounded(replaceSecrets(value, secrets));
  }
}

function safeText(value: string, secrets: string[] = []): string {
  return bounded(replaceSecrets(value, secrets))
    .replace(/\b(Bearer)\s+[^\s]+/gi, "$1 [redacted]")
    .replace(/\b(token|auth|key|password|secret|session|code|credential)\s*[:=]\s*[^\s|,;]+/gi, "$1=[redacted]");
}

function boundedCondition(condition: WaitCondition): WaitCondition {
  const copy = { ...condition } as WaitCondition & {
    value?: string;
    expected?: string;
    attribute?: string;
  };
  if (copy.value) copy.value = bounded(copy.value);
  if (copy.expected) copy.expected = bounded(copy.expected);
  if (copy.attribute) copy.attribute = bounded(copy.attribute);
  return copy;
}

function boundedDetails(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") return /url|opener/i.test(key) ? safeUrl(value) : bounded(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => boundedDetails(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([childKey, child]) => [childKey, boundedDetails(child, childKey, depth + 1)])
    );
  }
  return String(value);
}

async function defaultPopupMetadata(
  popup: Page,
  signal: AbortSignal
): Promise<{ targetId?: string; url?: string; title?: string }> {
  const title = await popup.title().catch(() => "");
  if (signal.aborted) throw signal.reason;
  let session: CDPSession | undefined;
  try {
    session = await popup.context().newCDPSession(popup);
    if (signal.aborted) throw signal.reason;
    const targetId = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
    return { targetId, url: popup.url(), title };
  } finally {
    await session?.detach().catch(() => {});
  }
}

async function enrichPopupWithDeadline(
  popup: Page,
  event: WaitEvents["popup"][number],
  lookup: NonNullable<WaitStateContext<unknown>["popupMetadata"]>
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("popup metadata deadline exceeded"));
      resolve(null);
    }, POPUP_METADATA_TIMEOUT_MS);
  });
  const metadata = await Promise.race([
    lookup(popup, controller.signal).catch(() => null),
    deadline,
  ]);
  if (timer) clearTimeout(timer);
  controller.abort(new Error("popup metadata lookup complete"));
  if (!metadata) {
    event.warning = "Popup metadata unavailable before deadline";
    return;
  }
  if (metadata.targetId) event.targetId = bounded(metadata.targetId);
  const urlSecrets = metadata.url ? sensitiveUrlValues(metadata.url) : [];
  if (metadata.url) event.url = safeUrl(metadata.url, urlSecrets);
  if (metadata.title !== undefined) event.title = safeText(metadata.title, urlSecrets);
  if (!metadata.targetId) event.warning = "Popup target id unavailable";
}

export async function capturePopupMetadata(popup: Page, opener: string): Promise<WaitEvents["popup"][number]> {
  const event: WaitEvents["popup"][number] = {
    url: safeUrl(popup.url()),
    title: "",
    opener: safeUrl(opener),
  };
  await enrichPopupWithDeadline(popup, event, defaultPopupMetadata);
  return event;
}

function matcher(match: "exact" | "contains" | "glob" | "safe-regex", expected: string) {
  if (match === "exact") return (actual: string) => actual === expected;
  if (match === "contains") return (actual: string) => actual.includes(expected);
  if (match === "safe-regex") {
    const regex = new RegExp(expected);
    return (actual: string) => regex.test(actual);
  }
  const regex = new RegExp(
    `^${expected
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
  );
  return (actual: string) => regex.test(actual);
}

async function domSnapshot(page: Page): Promise<{
  dialogs: string[];
  toasts: string[];
  refs: Record<
    string,
    {
      attached: boolean;
      visible: boolean;
      enabled: boolean;
      value: string;
      attributes: Record<string, string | null>;
      states: Record<string, string>;
    }
  >;
  truncated: boolean;
  hiddenFrameIds: string[];
}> {
  return await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const text = (selector: string) =>
      Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim());
    const refs: Record<
      string,
      {
        attached: boolean;
        visible: boolean;
        enabled: boolean;
        value: string;
        attributes: Record<string, string | null>;
        states: Record<string, string>;
      }
    > = {};
    const state = (
      window as Window & { __devBrowserPerceptionState?: { refs: WeakMap<Element, string> } }
    ).__devBrowserPerceptionState;
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const ref = element.getAttribute("data-dev-browser-ref") ?? state?.refs.get(element);
      if (!ref) continue;
      const input = element as HTMLInputElement;
      refs[ref] = {
        attached: true,
        visible: visible(element),
        enabled: !("disabled" in input) || !input.disabled,
        value: "value" in input ? String(input.value) : (element.textContent ?? ""),
        attributes: Object.fromEntries(
          Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])
        ),
        states: {
          checked: String(Boolean(input.checked)),
          selected: String(Boolean((element as HTMLOptionElement).selected)),
          expanded: element.getAttribute("aria-expanded") ?? "",
          pressed: element.getAttribute("aria-pressed") ?? "",
        },
      };
    }
    return {
      dialogs: text('[role="dialog"],dialog[open]'),
      toasts: text('[role="status"],[role="alert"],[data-toast],[data-testid*="toast"]'),
      refs,
      truncated: false,
      hiddenFrameIds: [],
    };
  });
}

async function scopedText(page: Page, scope: "body" | "dialog" | "toast"): Promise<string[]> {
  return await page.evaluate((selectedScope) => {
    const selector =
      selectedScope === "body"
        ? "body"
        : selectedScope === "dialog"
          ? '[role="dialog"],dialog[open]'
          : '[role="status"],[role="alert"],[data-toast],[data-testid*="toast"]';
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((element) =>
        ((element as HTMLElement).innerText ?? element.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
      );
  }, scope);
}

async function sharedDomSnapshot(page: Page, protocolVersion: 1 | 2): ReturnType<typeof domSnapshot> {
  if (protocolVersion === 1) return domSnapshot(page);
  const live = await collectLiveSnapshot(page);
  return { dialogs: live.dialogs, toasts: live.toasts, refs: live.refs, truncated: live.truncated, hiddenFrameIds: live.hiddenFrameIds };
}

async function sharedScopedText(page: Page, scope: "body" | "dialog" | "toast", protocolVersion: 1 | 2): Promise<{ texts: string[]; truncated: boolean }> {
  if (protocolVersion === 1) return { texts: await scopedText(page, scope), truncated: false };
  const live = await collectLiveSnapshot(page);
  return { texts: scope === "dialog" ? live.dialogs : scope === "toast" ? live.toasts : live.bodyText, truncated: live.truncated };
}

async function installTransientCapture(page: Page, ownerToken: string): Promise<void> {
  const installed = await page.evaluate((token) => {
    type SetterRestoration = {
      prototype: object;
      property: string;
      descriptor: PropertyDescriptor;
      setter: (this: unknown, value: unknown) => void;
    };
    type CaptureManager = {
      version: 1;
      ownerToken: string;
      captures: Map<string, TransientCapture>;
      observer: MutationObserver | null;
      setterRestorations: SetterRestoration[];
      cleanupToken(token: string): void;
      rollback(): void;
    };
    const captureWindow = window as Window & {
      __devBrowserWaitCaptureManager?: CaptureManager;
    };
    const existing = captureWindow.__devBrowserWaitCaptureManager;
    if (existing) {
      if (existing.version !== 1 || !(existing.captures instanceof Map))
        return { ok: false as const, reason: "A page-owned wait capture manager is incompatible" };
      existing.captures.set(token, { mutations: [], focusChanges: [], valueChanges: [] });
      return { ok: true as const };
    }

    const manager: CaptureManager = {
      version: 1,
      ownerToken: token,
      captures: new Map([[token, { mutations: [], focusChanges: [], valueChanges: [] }]]),
      observer: null,
      setterRestorations: [],
      cleanupToken: () => {},
      rollback: () => {},
    };
    captureWindow.__devBrowserWaitCaptureManager = manager;
    const pushBounded = <T>(items: T[], item: T) => {
      if (items.length < 50) items.push(item);
    };
    const broadcast = <Key extends keyof TransientCapture>(
      key: Key,
      item: TransientCapture[Key][number]
    ) => {
      for (const capture of manager.captures.values()) pushBounded(capture[key], item as never);
    };
    const describe = (target: EventTarget | Node | null): string => {
      if (!(target instanceof Element)) return target?.constructor.name ?? "unknown";
      return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${
        target.getAttribute("role") ? `[role=${target.getAttribute("role")}]` : ""
      }`.slice(0, 160);
    };
    const internalAttribute = (name: string | null) =>
      Boolean(name && /^data-dev-browser-(?:ref|action-ref|visual-overlay)$/.test(name));
    const internalNode = (node: Node) =>
      node instanceof Element &&
      (node.hasAttribute("data-dev-browser-visual-overlay") ||
        node.matches("[data-dev-browser-visual-overlay] *"));
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && internalAttribute(record.attributeName)) continue;
        if (
          record.type === "childList" &&
          [...record.addedNodes, ...record.removedNodes].every(internalNode)
        )
          continue;
        broadcast("mutations", {
          type: record.type,
          target: describe(record.target),
          ...(record.attributeName ? { attribute: record.attributeName } : {}),
        });
      }
    });
    const onFocus = (event: Event) =>
      broadcast("focusChanges", { type: event.type, target: describe(event.target) });
    const onValue = (event: Event) =>
      broadcast("valueChanges", { type: event.type, target: describe(event.target) });
    const restoreSetters = () => {
      for (const restoration of [...manager.setterRestorations].reverse()) {
        const current = Object.getOwnPropertyDescriptor(
          restoration.prototype,
          restoration.property
        );
        if (
          current?.set === restoration.setter &&
          (current.set as typeof current.set & { __devBrowserWaitOwner?: string })
            .__devBrowserWaitOwner === manager.ownerToken
        )
          Object.defineProperty(
            restoration.prototype,
            restoration.property,
            restoration.descriptor
          );
      }
    };
    const rollback = () => {
      manager.observer?.disconnect();
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("blur", onFocus, true);
      document.removeEventListener("input", onValue, true);
      document.removeEventListener("change", onValue, true);
      restoreSetters();
      manager.captures.clear();
      if (captureWindow.__devBrowserWaitCaptureManager === manager)
        delete captureWindow.__devBrowserWaitCaptureManager;
    };
    manager.rollback = rollback;
    manager.cleanupToken = (captureToken) => {
      manager.captures.delete(captureToken);
      if (manager.captures.size === 0) rollback();
    };
    const interceptSetter = (prototype: object, property: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.get || !descriptor.set || descriptor.configurable !== true)
        throw new Error(`Native setter ${property} is unavailable for safe capture`);
      const nativeGetter = descriptor.get;
      const nativeSetter = descriptor.set;
      const ownedSetter = function (this: unknown, value: unknown) {
        const before = Reflect.apply(nativeGetter, this, []);
        Reflect.apply(nativeSetter, this, [value]);
        const after = Reflect.apply(nativeGetter, this, []);
        if (before !== after)
          broadcast("valueChanges", {
            type: "property",
            target: describe(this as EventTarget),
            property,
          });
      };
      Object.defineProperty(ownedSetter, "__devBrowserWaitOwner", {
        value: manager.ownerToken,
      });
      manager.setterRestorations.push({
        prototype,
        property,
        descriptor,
        setter: ownedSetter,
      });
      Object.defineProperty(prototype, property, { ...descriptor, set: ownedSetter });
    };
    try {
      for (const [prototype, properties] of [
        [HTMLInputElement.prototype, ["value", "checked"]],
        [HTMLTextAreaElement.prototype, ["value"]],
        [HTMLSelectElement.prototype, ["value", "selectedIndex"]],
        [HTMLOptionElement.prototype, ["selected"]],
      ] as Array<[object, string[]]>)
        for (const property of properties) interceptSetter(prototype, property);
      manager.observer = observer;
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("blur", onFocus, true);
      document.addEventListener("input", onValue, true);
      document.addEventListener("change", onValue, true);
      return { ok: true as const };
    } catch (error) {
      rollback();
      return {
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }, ownerToken);
  if (!installed.ok)
    throw new AgentProtocolError(
      "UNSUPPORTED_CONTEXT",
      `Safe value capture unavailable: ${bounded(installed.reason)}`,
      false
    );
}

async function drainTransientCapture(
  page: Page,
  events: WaitEvents,
  ownerToken: string
): Promise<void> {
  const captured = await page
    .evaluate((token) => {
      const manager = (
        window as Window & {
          __devBrowserWaitCaptureManager?: {
            captures: Map<string, TransientCapture>;
          };
        }
      ).__devBrowserWaitCaptureManager;
      const capture = manager?.captures.get(token);
      if (!capture) return null;
      return {
        mutations: capture.mutations.splice(0),
        focusChanges: capture.focusChanges.splice(0),
        valueChanges: capture.valueChanges.splice(0),
      };
    }, ownerToken)
    .catch(() => null);
  if (!captured) return;
  events.mutations.push(...captured.mutations);
  events.focusChanges.push(...captured.focusChanges);
  events.valueChanges.push(...captured.valueChanges);
}

async function cleanupTransientCapture(page: Page, ownerToken: string): Promise<void> {
  await page
    .evaluate((token) => {
      const manager = (
        window as Window & {
          __devBrowserWaitCaptureManager?: { cleanupToken(token: string): void };
        }
      ).__devBrowserWaitCaptureManager;
      manager?.cleanupToken(token);
    }, ownerToken)
    .catch(() => {});
}

export async function runWithWait<State>(
  page: Page,
  stateContext: WaitStateContext<State>,
  spec: WaitSpec,
  dispatch: () => unknown | Promise<unknown>
): Promise<{ waitResult: WaitResult; state: State }> {
  if (page.isClosed())
    throw new AgentProtocolError("PAGE_CLOSED", "Page closed before wait dispatch", true);
  const started = Date.now();
  const protocolVersion = stateContext.protocolVersion ?? 2;
  const initial = await sharedDomSnapshot(page, protocolVersion);
  const refBaselines = new Map<string, (typeof initial.refs)[string] | undefined>();
  const coveredRefBaselines = new Set<string>();
  const initiallyTruncatedRefBaselines = new Set<string>();
  for (const condition of spec.conditions) {
    if (condition.kind !== "ref") continue;
    const baseline = initial.refs[condition.ref];
    if (baseline || !initial.truncated) {
      refBaselines.set(condition.ref, baseline);
      coveredRefBaselines.add(condition.ref);
    } else initiallyTruncatedRefBaselines.add(condition.ref);
  }
  const events: WaitEvents = {
    requests: [],
    mutations: [],
    focusChanges: [],
    valueChanges: [],
    dialogs: [],
    popup: [],
    download: [],
    fileChooser: [],
    navigation: [],
    responses: [],
    failedRequests: [],
  };
  const rawResponses: Array<{ url: string; method: string; status: number }> = [];
  const rawFailedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const pendingMetadata = new Set<Promise<void>>();
  const cleanups: Array<() => void> = [];
  let closed = false;
  let inFlight = 0;
  let lastNetworkActivity = Date.now();

  const listen = <K extends keyof Parameters<Page["on"]>[0] extends never ? never : string>(
    event: K,
    handler: (...args: never[]) => void
  ) => {
    page.on(event as never, handler as never);
    cleanups.push(() => page.off(event as never, handler as never));
  };
  const track = (promise: Promise<void>) => {
    pendingMetadata.add(promise);
    void promise.finally(() => pendingMetadata.delete(promise));
  };
  const onPopup = (popup: Page) => {
    stateContext.onPopup?.(popup);
    const event: WaitEvents["popup"][number] = {
      url: safeUrl(popup.url()),
      title: "",
      opener: safeUrl(page.url()),
    };
    events.popup.push(event);
    track(
      enrichPopupWithDeadline(popup, event, stateContext.popupMetadata ?? defaultPopupMetadata)
    );
  };
  const onDownload = (download: Download) => {
    stateContext.onDownload?.(download);
    track(
      Promise.resolve().then(() => {
        events.download.push({
          url: safeUrl(download.url()),
          suggestedFilename: bounded(download.suggestedFilename()),
        });
      })
    );
  };
  const onFileChooser = (chooser: FileChooser) =>
    events.fileChooser.push({ multiple: chooser.isMultiple() });
  const onDialog = (dialog: Dialog) => {
    events.dialogs.push({ type: dialog.type(), message: bounded(dialog.message()) });
    track(dialog.dismiss().catch(() => {}));
  };
  const onNavigation = (frame: Frame) =>
    events.navigation.push({ url: safeUrl(frame.url()), document: frame === page.mainFrame() });
  const onResponse = (response: Response) => {
    const raw = {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    };
    rawResponses.push(raw);
    events.responses.push({ ...raw, url: safeUrl(raw.url) });
  };
  const onRequest = (request: Request) => {
    inFlight += 1;
    lastNetworkActivity = Date.now();
    events.requests.push({ url: safeUrl(request.url()), method: request.method() });
  };
  const onRequestDone = () => {
    inFlight = Math.max(0, inFlight - 1);
    lastNetworkActivity = Date.now();
  };
  const onRequestFailed = (request: Request) => {
    onRequestDone();
    const raw = {
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText ? bounded(request.failure()!.errorText) : null,
    };
    rawFailedRequests.push(raw);
    events.failedRequests.push({ ...raw, url: safeUrl(raw.url) });
  };
  const onClose = () => {
    closed = true;
  };

  listen("popup", onPopup as never);
  listen("download", onDownload as never);
  listen("filechooser", onFileChooser as never);
  listen("dialog", onDialog as never);
  listen("framenavigated", onNavigation as never);
  listen("response", onResponse as never);
  listen("request", onRequest as never);
  listen("requestfinished", onRequestDone as never);
  listen("requestfailed", onRequestFailed as never);
  listen("close", onClose as never);

  const observe = async (condition: WaitCondition): Promise<ConditionObservation> => {
    if (
      condition.kind === "popup" ||
      condition.kind === "download" ||
      condition.kind === "fileChooser"
    ) {
      const list = condition.kind === "fileChooser" ? events.fileChooser : events[condition.kind];
      return { condition, passed: list.length > 0, observed: list.length };
    }
    if (condition.kind === "navigation") {
      const matched = events.navigation.filter(
        (event) => condition.state === "navigation" || event.document
      );
      return { condition, passed: matched.length > 0, observed: matched.at(-1)?.url ?? null };
    }
    if (condition.kind === "response") {
      const matches = rawResponses.filter(
        (event) =>
          matcher(condition.match, condition.value)(event.url) &&
          (!condition.method || event.method === condition.method.toUpperCase()) &&
          (!condition.status || event.status === condition.status)
      );
      return { condition, passed: matches.length > 0, observed: matches.at(-1)?.status ?? null };
    }
    if (condition.kind === "failedRequest") {
      const matches = rawFailedRequests.filter(
        (event) =>
          matcher(condition.match, condition.value)(event.url) &&
          (!condition.method || event.method === condition.method.toUpperCase())
      );
      return { condition, passed: matches.length > 0, observed: matches.at(-1)?.failure ?? null };
    }
    if (condition.kind === "networkIdle") {
      const idleFor = Date.now() - lastNetworkActivity;
      return {
        condition,
        passed: inFlight === 0 && idleFor >= condition.idleMs,
        observed: idleFor,
      };
    }
    if (condition.kind === "url") {
      const actual = page.url();
      return {
        condition,
        passed: matcher(condition.match, condition.value)(actual),
        observed: safeUrl(actual),
      };
    }
    if (condition.kind === "text") {
      const scoped = await sharedScopedText(page, condition.scope, protocolVersion);
      const matched = scoped.texts.some(matcher(condition.match, condition.value));
      return {
        condition,
        passed: !scoped.truncated && (condition.state === "visible" ? matched : !matched),
        observed: bounded(scoped.texts.join(" | ")),
        coverage: scoped.truncated ? "truncated" : "complete",
      };
    }
    const current = await sharedDomSnapshot(page, protocolVersion);
    if (condition.kind === "dialog" || condition.kind === "toast") {
      const before = condition.kind === "dialog" ? initial.dialogs : initial.toasts;
      const after = condition.kind === "dialog" ? current.dialogs : current.toasts;
      const passed =
        !initial.truncated && !current.truncated &&
        (condition.state === "opened" ? after.length > before.length : after.length < before.length);
      return { condition, passed, observed: after.length, coverage: initial.truncated || current.truncated ? "truncated" : "complete" };
    }
    if (condition.kind !== "ref") {
      throw new Error(`Unsupported wait condition: ${(condition as { kind: string }).kind}`);
    }
    let before = refBaselines.get(condition.ref);
    const after = current.refs[condition.ref];
    const frameId = /^(F\d+):/.exec(condition.ref)?.[1] ?? "F0";
    const hiddenByFrame = current.hiddenFrameIds.includes(frameId);
    const unknownAbsent = !after && current.truncated;
    if (condition.state === "attached" || condition.state === "detached") {
      return {
        condition,
        passed: unknownAbsent ? false : condition.state === "attached" ? Boolean(after) || hiddenByFrame : !after && !hiddenByFrame,
        observed: Boolean(after) || hiddenByFrame,
        coverage: unknownAbsent ? "truncated" : "complete",
      };
    }
    if (condition.state === "visible" || condition.state === "hidden") {
      const visible = hiddenByFrame ? false : Boolean(after?.visible);
      return {
        condition,
        passed: unknownAbsent ? false : condition.state === "visible" ? visible : hiddenByFrame || !visible,
        observed: visible,
        coverage: unknownAbsent ? "truncated" : "complete",
      };
    }
    if (condition.state === "enabled" || condition.state === "disabled") {
      if (!after) return { condition, passed: false, observed: null, coverage: current.truncated ? "truncated" : "complete" };
      const enabled = after.enabled;
      return {
        condition,
        passed: condition.state === "enabled" ? enabled : !enabled,
        observed: enabled,
      };
    }
    if (!coveredRefBaselines.has(condition.ref)) {
      if (after || !current.truncated) {
        refBaselines.set(condition.ref, after);
        coveredRefBaselines.add(condition.ref);
      }
      return { condition, passed: false, observed: after?.value ?? null, coverage: "truncated" };
    }
    before = refBaselines.get(condition.ref);
    let previous: string | null | undefined;
    let actual: string | null | undefined;
    if (condition.state === "valueChanged") {
      previous = before?.value;
      actual = after?.value;
    } else if (condition.state === "attributeChanged") {
      previous = before?.attributes[condition.attribute!];
      actual = after?.attributes[condition.attribute!];
    } else {
      const name = condition.attribute ?? "checked";
      previous = before?.states[name] ?? before?.attributes[name];
      actual = after?.states[name] ?? after?.attributes[name];
    }
    return {
      condition,
      passed: !unknownAbsent &&
        actual !== previous && (condition.expected === undefined || actual === condition.expected),
      observed: actual ?? null,
      coverage: unknownAbsent || initiallyTruncatedRefBaselines.has(condition.ref) ? "truncated" : "complete",
    };
  };

  const captureOwnerToken = `wait-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await installTransientCapture(page, captureOwnerToken);
    await dispatch();
    let observations: ConditionObservation[] = [];
    while (true) {
      if (closed || page.isClosed())
        throw new AgentProtocolError(
          "PAGE_CLOSED",
          "Page closed while waiting for action conditions",
          true
        );
      await drainTransientCapture(page, events, captureOwnerToken);
      observations = await Promise.all(spec.conditions.map(observe));
      const complete =
        spec.mode === "all"
          ? observations.every((entry) => entry.passed)
          : observations.some((entry) => entry.passed);
      if (complete) {
        await Promise.allSettled([...pendingMetadata]);
        return {
          waitResult: {
            mode: spec.mode,
            elapsedMs: Date.now() - started,
            passed: observations.filter((entry) => entry.passed).map((entry) => entry.condition),
            timedOut: observations.filter((entry) => !entry.passed).map((entry) => entry.condition),
            observations,
            events,
          },
          state: await stateContext.collect(),
        };
      }
      if (Date.now() - started >= spec.timeoutMs) {
        const passed = observations
          .filter((entry) => entry.passed)
          .map((entry) => boundedCondition(entry.condition));
        const timedOut = observations
          .filter((entry) => !entry.passed)
          .map((entry) => boundedCondition(entry.condition));
        const boundedObservations = observations.map((entry) => ({
          ...entry,
          condition: boundedCondition(entry.condition),
          observed: boundedDetails(entry.observed, "observed"),
        }));
        throw new AgentProtocolError(
          "WAIT_TIMEOUT",
          `Wait conditions timed out after ${spec.timeoutMs}ms`,
          true,
          {
            details: {
              mode: spec.mode,
              elapsedMs: Date.now() - started,
              passed,
              timedOut,
              observations: boundedObservations,
              events: boundedDetails(events, "events"),
            },
            nextCommands: ["dev-browser observe --delta"],
          }
        );
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(POLL_INTERVAL_MS, Math.max(1, spec.timeoutMs - (Date.now() - started)))
        )
      );
    }
  } catch (error) {
    await drainTransientCapture(page, events, captureOwnerToken);
    if (error !== null && (typeof error === "object" || typeof error === "function"))
      capturedEventsByError.set(error as object, events);
    throw error;
  } finally {
    await drainTransientCapture(page, events, captureOwnerToken);
    await cleanupTransientCapture(page, captureOwnerToken);
    for (const cleanup of cleanups.splice(0)) cleanup();
    await Promise.allSettled([...pendingMetadata]);
  }
}
