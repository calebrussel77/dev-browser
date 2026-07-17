import type { CDPSession, Download, FileChooser, Frame, Page, Request, Response } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import type { WaitCondition, WaitSpec } from "./protocol.js";

const POLL_INTERVAL_MS = 25;
const MAX_OBSERVATION_LENGTH = 160;

type ConditionObservation = {
  condition: WaitCondition;
  passed: boolean;
  observed?: string | number | boolean | null;
};

export interface WaitEvents {
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
  popupMetadata?: (
    popup: Page,
    signal: AbortSignal
  ) => Promise<{ targetId?: string; url?: string; title?: string }>;
}

const POPUP_METADATA_TIMEOUT_MS = 500;

function bounded(value: string): string {
  return value.length <= MAX_OBSERVATION_LENGTH
    ? value
    : `${value.slice(0, MAX_OBSERVATION_LENGTH - 3)}...`;
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "[redacted]";
    if (parsed.password) parsed.password = "[redacted]";
    for (const key of parsed.searchParams.keys()) {
      if (/token|auth|key|password|secret|session/i.test(key))
        parsed.searchParams.set(key, "[redacted]");
    }
    return bounded(parsed.toString());
  } catch {
    return bounded(value);
  }
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
  if (metadata.url) event.url = safeUrl(metadata.url);
  if (metadata.title !== undefined) event.title = bounded(metadata.title);
  if (!metadata.targetId) event.warning = "Popup target id unavailable";
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
      .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim());
  }, scope);
}

export async function runWithWait<State>(
  page: Page,
  stateContext: WaitStateContext<State>,
  spec: WaitSpec,
  dispatch: () => void | Promise<void>
): Promise<{ waitResult: WaitResult; state: State }> {
  if (page.isClosed())
    throw new AgentProtocolError("PAGE_CLOSED", "Page closed before wait dispatch", true);
  const started = Date.now();
  const initial = await domSnapshot(page);
  const events: WaitEvents = {
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
  const onDownload = (download: Download) =>
    track(
      Promise.resolve().then(() => {
        events.download.push({
          url: safeUrl(download.url()),
          suggestedFilename: bounded(download.suggestedFilename()),
        });
      })
    );
  const onFileChooser = (chooser: FileChooser) =>
    events.fileChooser.push({ multiple: chooser.isMultiple() });
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
  const onRequest = () => {
    inFlight += 1;
    lastNetworkActivity = Date.now();
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
      const texts = await scopedText(page, condition.scope);
      const matched = texts.some(matcher(condition.match, condition.value));
      return {
        condition,
        passed: condition.state === "visible" ? matched : !matched,
        observed: bounded(texts.join(" | ")),
      };
    }
    const current = await domSnapshot(page);
    if (condition.kind === "dialog" || condition.kind === "toast") {
      const before = condition.kind === "dialog" ? initial.dialogs : initial.toasts;
      const after = condition.kind === "dialog" ? current.dialogs : current.toasts;
      const passed =
        condition.state === "opened" ? after.length > before.length : after.length < before.length;
      return { condition, passed, observed: after.length };
    }
    if (condition.kind !== "ref") {
      throw new Error(`Unsupported wait condition: ${(condition as { kind: string }).kind}`);
    }
    const before = initial.refs[condition.ref];
    const after = current.refs[condition.ref];
    if (condition.state === "attached" || condition.state === "detached") {
      return {
        condition,
        passed: condition.state === "attached" ? Boolean(after) : !after,
        observed: Boolean(after),
      };
    }
    if (condition.state === "visible" || condition.state === "hidden") {
      const visible = Boolean(after?.visible);
      return {
        condition,
        passed: condition.state === "visible" ? visible : !visible,
        observed: visible,
      };
    }
    if (condition.state === "enabled" || condition.state === "disabled") {
      if (!after) return { condition, passed: false, observed: null };
      const enabled = after.enabled;
      return {
        condition,
        passed: condition.state === "enabled" ? enabled : !enabled,
        observed: enabled,
      };
    }
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
      passed:
        actual !== previous && (condition.expected === undefined || actual === condition.expected),
      observed: actual ?? null,
    };
  };

  try {
    await dispatch();
    let observations: ConditionObservation[] = [];
    while (true) {
      if (closed || page.isClosed())
        throw new AgentProtocolError(
          "PAGE_CLOSED",
          "Page closed while waiting for action conditions",
          true
        );
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
  } finally {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await Promise.allSettled([...pendingMetadata]);
  }
}
