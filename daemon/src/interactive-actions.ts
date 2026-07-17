import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { attemptErrorReason, boundedWaitEvents, emptyWaitEvents, mergeWaitEvents, trustedInputError as attemptError, withAttemptJournal } from "./action-journal.js";
import { executePrimitive, type PrimitiveSummary } from "./actions/primitives.js";
import { BrowserManager } from "./browser-manager.js";
import {
  collectPageState,
  type CollectPageStateOptions,
  type PagePerception,
  type PerceptionElement,
} from "./perception/collector.js";
import type { InteractiveRequest, WaitSpec } from "./protocol.js";
import { discardValidationState, getLatestStateId } from "./page-state.js";
import { validateObservedDecision } from "./ref-state.js";
import {
  retryDecision,
  type AttemptChange,
  type AttemptJournalEntry,
  type RetryPolicy,
} from "./retry-policy.js";
import { pageLeases } from "./sessions.js";
import { captureVisualArtifacts, type VisualArtifacts } from "./visual-artifacts.js";
import {
  capturedWaitEvents,
  runWithWait,
  type WaitEvents,
  type WaitResult,
} from "./wait-engine.js";

export type InteractiveElement = PerceptionElement;

export interface InteractiveMatch extends InteractiveElement {
  score: number;
}

export interface InteractiveResult {
  action: InteractiveRequest["action"]["kind"];
  page: string;
  url?: string;
  title?: string;
  pages?: Awaited<ReturnType<BrowserManager["listPages"]>>;
  snapshot?: string;
  elements?: InteractiveElement[];
  matches?: InteractiveMatch[];
  documentId?: string;
  stateId?: string;
  tree?: string;
  focusedRef?: string | null;
  delta?: PagePerception["delta"];
  warnings?: string[];
  truncation?: PagePerception["truncation"];
  clicked?: {
    ref: string | null;
    method: "mouse" | "locator";
    point: { x: number; y: number };
    resolvedBy?: "self" | "descendant" | "ancestor";
  };
  typed?: {
    ref: string | null;
    characters: number;
  };
  confirmation?: {
    confirmed: boolean;
    expected: string | null;
    text: string;
  };
  screenshotPath?: string;
  artifacts?: VisualArtifacts;
  coordinateSpace?: {
    unit: "css-px";
    screenshotScale: "css";
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    scroll?: { x: number; y: number };
  };
  change?: {
    any: boolean;
    url: boolean;
    snapshot: boolean;
    dialog: boolean;
    ariaExpanded: boolean;
    dom: boolean;
    focus: boolean;
    value: boolean;
  };
  attempts?: number;
  attemptJournal?: AttemptJournalEntry[];
  waitForText?: string | null;
  waitSatisfied?: boolean | null;
  waitResult?: WaitResult;
  pressed?: PrimitiveSummary["pressed"];
  pasted?: PrimitiveSummary["pasted"];
  scroll?: PrimitiveSummary["scroll"];
  selected?: PrimitiveSummary["selected"];
  checked?: PrimitiveSummary["checked"];
  hovered?: PrimitiveSummary["hovered"];
  dragged?: PrimitiveSummary["dragged"];
}

export interface ActionExecutionHooks {
  beforeTrustedInput?: () => void | Promise<void>;
}

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_READ_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 10;
const MAX_CONFIRMATION_TEXT_LENGTH = 8_000;
const MAX_ERROR_CONTEXT_LENGTH = 500;
const REF_PATTERN = /^R\d+$/;
const CLICK_SETTLE_MS = 100;
const STOP_WORDS = new Set([
  "a",
  "au",
  "aux",
  "dans",
  "de",
  "des",
  "du",
  "le",
  "la",
  "les",
  "of",
  "the",
]);

function summarizeErrorContext(value: string): string {
  if (value.length <= MAX_ERROR_CONTEXT_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_CONTEXT_LENGTH - 3)}...`;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryTokens(query: string): string[] {
  return normalizeText(query)
    .split(" ")
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function scoreElement(element: InteractiveElement, query: string): number {
  if (!element.visible) {
    return -1;
  }

  const normalizedQuery = normalizeText(query);
  const name = normalizeText(element.name);
  const role = normalizeText(element.role);
  const landmark = normalizeText(element.landmark);
  let score = 0;

  if (name === normalizedQuery) {
    score += 100;
  } else if (name.length > 0 && normalizedQuery.includes(name)) {
    score += 40;
  }

  for (const token of queryTokens(query)) {
    if (name.split(" ").includes(token)) {
      score += 12;
    } else if (name.includes(token)) {
      score += 8;
    }
    if (role.includes(token)) {
      score += 5;
    }
    if (landmark.includes(token)) {
      score += 9;
    }
  }

  return score;
}

async function resolveRef(page: Page, ref: string) {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`Invalid element ref "${ref}"`);
  }

  let selector = `[data-dev-browser-ref="${ref}"]`;
  let temporary = false;
  let original = page.locator(selector).first();
  if ((await original.count()) === 0) {
    temporary = await page.evaluate((requestedRef) => {
      const state = (
        window as Window & {
          __devBrowserPerceptionState?: { refs: WeakMap<Element, string> };
        }
      ).__devBrowserPerceptionState;
      if (!state) return false;
      const element = Array.from(document.querySelectorAll("*")).find(
        (candidate) => state.refs.get(candidate) === requestedRef
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
  if ((await original.count()) === 0) {
    const boundedRef = summarizeErrorContext(ref);
    throw new AgentProtocolError(
      "STALE_REF",
      `Element ref "${boundedRef}" is stale or missing; run read again`,
      true,
      { details: { ref: boundedRef, refLength: ref.length }, nextCommands: ["dev-browser read"] }
    );
  }
  const cleanup = async () => {
    if (temporary) {
      await page
        .locator(selector)
        .evaluateAll((elements) =>
          elements.forEach((element) => element.removeAttribute("data-dev-browser-action-ref"))
        );
    }
  };

  let locator = original;
  let resolvedBy: "self" | "descendant" | "ancestor" = "self";
  const role = await original.evaluate((element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    return element.tagName.toLowerCase() === "a" ? "link" : "";
  });
  if (role === "link") {
    const descendant = original
      .locator(
        "button,[role='button'],input[type='button'],input[type='submit'],input[type='reset']"
      )
      .first();
    if ((await descendant.count()) > 0 && (await descendant.boundingBox())) {
      locator = descendant;
      resolvedBy = "descendant";
    }
  }

  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    const ancestor = original
      .locator(
        "xpath=ancestor::*[self::button or self::a[@href] or @role='button' or @role='link'][1]"
      )
      .first();
    const ancestorBox = (await ancestor.count()) > 0 ? await ancestor.boundingBox() : null;
    if (!ancestorBox || ancestorBox.width <= 0 || ancestorBox.height <= 0) {
      const boundedRef = summarizeErrorContext(ref);
      throw new AgentProtocolError(
        "TARGET_HIDDEN",
        `Element ref "${boundedRef}" is not visible; run read again`,
        true,
        { details: { ref: boundedRef, refLength: ref.length }, nextCommands: ["dev-browser read"] }
      );
    }
    return { box: ancestorBox, locator: ancestor, resolvedBy: "ancestor" as const, cleanup };
  }

  return { box, locator, resolvedBy, cleanup };
}

async function readConfirmationText(page: Page): Promise<string> {
  const dialogs = page.locator('[role="dialog"]:visible, dialog:visible');
  const count = await dialogs.count();
  const text =
    count > 0 ? await dialogs.nth(count - 1).innerText() : await page.locator("body").innerText();
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CONFIRMATION_TEXT_LENGTH);
}

async function requireExpectedText(page: Page, expected: string): Promise<string> {
  const text = await readConfirmationText(page);
  if (!normalizeText(text).includes(normalizeText(expected))) {
    throw new Error(
      `Confirmation text does not contain expected recipient/text "${expected}". Current text: ${text.slice(0, 500)}`
    );
  }
  return text;
}

function automaticScreenshotName(action: string): string {
  return `interactive/${Date.now()}-${action}.png`;
}

function limitSnapshotDepth(snapshot: string, depth: number): string {
  return snapshot
    .split("\n")
    .filter((line) => {
      const indentation = line.length - line.trimStart().length;
      return Math.floor(indentation / 2) < depth;
    })
    .join("\n");
}

async function snapshot(page: Page, depth = 12): Promise<string> {
  const value = await page.locator("body").ariaSnapshot({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
  return limitSnapshotDepth(value, depth);
}

async function perceive(
  page: Page,
  options: CollectPageStateOptions = {},
  legacyRefs = false
): Promise<PagePerception> {
  return await collectPageState(page, { ...options, legacyRefs });
}

function applyPerception(
  result: InteractiveResult,
  perception: PagePerception,
  protocolVersion: 1 | 2,
  includeElements = true
): void {
  result.documentId = perception.documentId;
  result.stateId = perception.stateId;
  result.tree = perception.tree;
  result.focusedRef = perception.focusedRef;
  result.delta = perception.delta;
  result.warnings = [...(result.warnings ?? []), ...perception.warnings];
  result.truncation = perception.truncation;
  result.coordinateSpace =
    protocolVersion === 2
      ? perception.coordinateSpace
      : {
          unit: perception.coordinateSpace.unit,
          screenshotScale: perception.coordinateSpace.screenshotScale,
          viewport: perception.coordinateSpace.viewport,
          devicePixelRatio: perception.coordinateSpace.devicePixelRatio,
        };
  if (protocolVersion === 1) result.snapshot = perception.tree;
  if (includeElements) {
    const visibleElements = perception.elements.filter((element) => element.actionable);
    result.elements = visibleElements;
  }
}

interface PageSignal {
  url: string;
  snapshot: string;
  dialogs: string[];
  ariaExpanded: string[];
  dom: string;
  focus: string;
  values: string[];
}

async function pageSignal(page: Page): Promise<PageSignal> {
  const state = await page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    return {
      dialogs: Array.from(document.querySelectorAll('[role="dialog"],dialog'))
        .filter(visible)
        .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim()),
      ariaExpanded: Array.from(document.querySelectorAll("[aria-expanded]"))
        .filter(visible)
        .map(
          (element) =>
            `${element.getAttribute("data-dev-browser-ref") ?? element.id}:${element.getAttribute("aria-expanded")}`
        ),
      dom: document.documentElement.outerHTML.replace(
        / data-dev-browser-(?:ref|action-ref)="[^"]*"/g,
        ""
      ),
      focus: (() => {
        const element = document.activeElement;
        if (!element || element === document.body) return "";
        return `${element.tagName}:${element.id}:${element.getAttribute("name") ?? ""}:${element.getAttribute("aria-label") ?? ""}`;
      })(),
      values: Array.from(
        document.querySelectorAll("input,textarea,select,[contenteditable=true]")
      ).map((element, index) => {
        const field = element as HTMLInputElement;
        return `${index}:${"value" in field ? field.value : (element.textContent ?? "")}`;
      }),
    };
  });
  return { url: page.url(), snapshot: await snapshot(page), ...state };
}

function compareSignals(before: PageSignal, after: PageSignal): AttemptChange {
  const change = {
    url: before.url !== after.url,
    snapshot: before.snapshot !== after.snapshot,
    dialog: JSON.stringify(before.dialogs) !== JSON.stringify(after.dialogs),
    ariaExpanded: JSON.stringify(before.ariaExpanded) !== JSON.stringify(after.ariaExpanded),
    dom: before.dom !== after.dom,
    focus: before.focus !== after.focus,
    value: JSON.stringify(before.values) !== JSON.stringify(after.values),
    any: false,
  };
  change.any =
    change.url ||
    change.snapshot ||
    change.dialog ||
    change.ariaExpanded ||
    change.dom ||
    change.focus ||
    change.value;
  return change;
}

function actionWaitSpec(
  action: InteractiveRequest["action"],
  timeoutMs?: number
): WaitSpec | undefined {
  if ("wait" in action && action.wait) return action.wait;
  if (action.kind === "click" && action.waitForText) {
    return {
      mode: "all",
      timeoutMs: Math.min(timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, 5_000),
      conditions: [
        {
          kind: "text",
          state: "visible",
          scope: "body",
          match: "contains",
          value: action.waitForText,
        },
      ],
    };
  }
  return undefined;
}

function timeoutEvents(error: AgentProtocolError): WaitEvents {
  const events = (error.details as { events?: WaitEvents } | undefined)?.events;
  return boundedWaitEvents(events ?? capturedWaitEvents(error) ?? emptyWaitEvents());
}

async function hasIrreversibleClickIntent(
  page: Page,
  action: Extract<InteractiveRequest["action"], { kind: "click" }>
): Promise<boolean> {
  const descriptor = await page.evaluate((target) => {
    let element: Element | null = null;
    if ("ref" in target) {
      const state = (
        window as Window & { __devBrowserPerceptionState?: { refs: WeakMap<Element, string> } }
      ).__devBrowserPerceptionState;
      element =
        Array.from(document.querySelectorAll("*")).find(
          (candidate) =>
            candidate.getAttribute("data-dev-browser-ref") === target.ref ||
            state?.refs.get(candidate) === target.ref
        ) ?? null;
    } else {
      element = document.elementFromPoint(target.x, target.y);
    }
    if (!element) return "";
    const input = element as HTMLInputElement;
    return [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("role"),
      element.closest("form") || element.hasAttribute("type") ? input.type : "",
      input.value,
    ]
      .filter(Boolean)
      .join(" ");
  }, action);
  return /\b(delete|remove|destroy|erase|submit|send|confirm|approve|pay|purchase|publish|post|supprimer|effacer|envoyer|confirmer|payer|publier)\b/i.test(
    descriptor
  );
}

export async function executeInteractiveAction(
  manager: BrowserManager,
  request: InteractiveRequest,
  hooks: ActionExecutionHooks = {}
): Promise<InteractiveResult> {
  const { action } = request;

  if (action.kind === "paste" && (request.shot || request.annotate)) {
    throw new AgentProtocolError("UNSUPPORTED_CONTEXT", "Paste cannot create screenshots or annotations", false);
  }

  if (action.kind === "pages") {
    return {
      action: action.kind,
      page: request.page,
      pages: await manager.listPages(request.browser),
    };
  }

  const page = await manager.getPage(request.browser, request.page);
  const protocolVersion = request.protocolVersion ?? 1;
  const result: InteractiveResult = {
    action: action.kind,
    page: request.page,
  };

  const authorizeTrustedMutation = async () => {
    await hooks.beforeTrustedInput?.();
    pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
  };

  if (protocolVersion === 2 && (action.kind === "type" || (action.kind === "shot" && action.ref))) {
    const previousLatestStateId = getLatestStateId(page);
    const latest = await perceive(page, {}, false);
    result.warnings = validateObservedDecision(
      page,
      request.page,
      action,
      "ref" in action ? action.ref : undefined,
      latest,
      previousLatestStateId
    );
    discardValidationState(page, latest.stateId, previousLatestStateId);
  }

  switch (action.kind) {
    case "navigate":
      if (action.wait) {
        const waited = await runWithWait(
          page,
          { collect: () => perceive(page, { delta: true }, protocolVersion === 1) },
          action.wait,
          async () => {
            await authorizeTrustedMutation();
            await page.goto(action.url, {
              timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
              waitUntil: "domcontentloaded",
            });
          }
        );
        result.waitResult = waited.waitResult;
        applyPerception(result, waited.state, protocolVersion);
      } else {
        await authorizeTrustedMutation();
        await page.goto(action.url, {
          timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        applyPerception(result, await perceive(page, {}, protocolVersion === 1), protocolVersion);
      }
      break;

    case "observe": {
      const perception = await perceive(
        page,
        {
          full: action.full,
          delta: action.delta,
          track: action.track,
          maxNodes: action.maxNodes,
          maxChars: action.maxChars,
          depth: action.depth,
          breadth: action.breadth,
          continuation: action.continuation,
        },
        false
      );
      applyPerception(result, perception, protocolVersion);
      break;
    }

    case "read": {
      const perception = await perceive(
        page,
        { maxNodes: action.limit ?? DEFAULT_READ_LIMIT, depth: action.depth },
        protocolVersion === 1
      );
      applyPerception(result, perception, protocolVersion);
      break;
    }

    case "find": {
      const perception = await perceive(page, {}, protocolVersion === 1);
      applyPerception(result, perception, protocolVersion, protocolVersion === 1);
      result.matches = perception.elements
        .filter((element) => element.actionable)
        .map((element) => ({ ...element, score: scoreElement(element, action.query) }))
        .filter((element) => element.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, action.limit ?? DEFAULT_FIND_LIMIT);
      break;
    }

    case "click": {
      if (action.expectText) {
        await requireExpectedText(page, action.expectText);
      }
      const before = await pageSignal(page);
      const revalidateClick = async () => {
        if (protocolVersion !== 2) return;
        const previousLatestStateId = getLatestStateId(page);
        const latest = await perceive(page, {}, false);
        const warnings = validateObservedDecision(
          page,
          request.page,
          action,
          "ref" in action ? action.ref : undefined,
          latest,
          previousLatestStateId
        );
        discardValidationState(page, latest.stateId, previousLatestStateId);
        result.warnings = [...(result.warnings ?? []), ...warnings];
      };
      const prepareClickInput = async () => {
        await hooks.beforeTrustedInput?.();
        await revalidateClick();
      };
      const clickOnce = async () => {
        if ("ref" in action) {
          const { box, locator, resolvedBy, cleanup } = await resolveRef(page, action.ref);
          const point = {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          };
          try {
            if (action.method === "locator") {
              await prepareClickInput();
              pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
              await locator.click({ timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
            } else {
              await prepareClickInput();
              pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
              await page.mouse.click(point.x, point.y);
            }
          } finally {
            await cleanup();
          }
          result.clicked = { ref: action.ref, method: action.method, point, resolvedBy };
        } else {
          await prepareClickInput();
          pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
          await page.mouse.click(action.x, action.y);
          result.clicked = {
            ref: null,
            method: "mouse",
            point: { x: action.x, y: action.y },
            resolvedBy: "self",
          };
        }
      };

      const wait = actionWaitSpec(action, request.timeoutMs);
      const legacyCompatibility =
        protocolVersion === 1 && action.waitForText !== undefined && action.retry === undefined;
      const policy: RetryPolicy = action.retry ?? (legacyCompatibility ? "safe" : "never");
      if (legacyCompatibility) {
        result.warnings = [
          ...(result.warnings ?? []),
          "Legacy v1 --wait-for retry compatibility is active; migrate to protocol v2 with an explicit retry policy",
        ];
      }
      const irreversibleIntent = await hasIrreversibleClickIntent(page, action);
      if (irreversibleIntent) {
        result.warnings = [
          ...(result.warnings ?? []),
          "Click target appears to have submission or destructive intent; explicit once retry is disabled",
        ];
      }

      const journal: AttemptJournalEntry[] = [];
      let after = before;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const startedAt = new Date().toISOString();
        let attemptBefore = after;
        try {
          attemptBefore = await pageSignal(page);
          const monitoringWait: WaitSpec = wait ?? {
            mode: "all",
            timeoutMs: CLICK_SETTLE_MS,
            conditions: [{ kind: "networkIdle", specialized: true, idleMs: 25 }],
          };
          const waited = await runWithWait(
            page,
            { collect: () => perceive(page, { delta: true }, protocolVersion === 1) },
            monitoringWait,
            clickOnce
          );
          after = await pageSignal(page);
          journal.push({
            attempt,
            startedAt,
            inputMethod: action.method,
            sideEffects: waited.waitResult.events,
            change: compareSignals(attemptBefore, after),
            retryDecision: "stop",
            reason: wait ? "wait-satisfied" : "action-complete",
          });
          result.waitResult = wait ? waited.waitResult : undefined;
          applyPerception(result, waited.state, protocolVersion);
          break;
        } catch (error) {
          const sideEffects = boundedWaitEvents(
            capturedWaitEvents(error) ??
              (error instanceof AgentProtocolError ? timeoutEvents(error) : emptyWaitEvents())
          );
          const typedError = attemptError(error, page);
          after = await pageSignal(page).catch(() => attemptBefore);
          const change = compareSignals(attemptBefore, after);
          if (!wait && typedError.code === "WAIT_TIMEOUT") {
            journal.push({
              attempt,
              startedAt,
              inputMethod: action.method,
              sideEffects,
              change,
              retryDecision: "stop",
              reason: "action-complete",
            });
            break;
          }
          if (typedError.code !== "WAIT_TIMEOUT") {
            journal.push({
              attempt,
              startedAt,
              inputMethod: action.method,
              sideEffects,
              change,
              retryDecision: "stop",
              reason: attemptErrorReason(typedError),
            });
            throw withAttemptJournal(typedError, journal);
          }
          const decision = retryDecision({
            policy,
            attempt,
            guarded: Boolean(action.expectText),
            irreversibleIntent,
            sideEffects,
            change,
          });
          journal.push({
            attempt,
            startedAt,
            inputMethod: action.method,
            sideEffects,
            change,
            ...decision,
          });
          if (decision.retryDecision === "retry") continue;
          throw withAttemptJournal(
            new AgentProtocolError(
              typedError.code,
              `${typedError.message} after ${journal.length} attempt${journal.length === 1 ? "" : "s"}`,
              typedError.recoverable,
              { details: typedError.details, nextCommands: typedError.nextCommands }
            ),
            journal
          );
        }
      }
      result.change = compareSignals(before, after);
      result.attempts = journal.length;
      result.attemptJournal = journal;
      result.waitForText = action.waitForText ?? null;
      result.waitSatisfied = action.waitForText ? true : null;
      if (!result.stateId)
        applyPerception(result, await perceive(page, {}, protocolVersion === 1), protocolVersion);
      break;
    }

    case "type": {
      const dispatchType = async () => {
        if (action.ref) {
          const { box, cleanup } = await resolveRef(page, action.ref);
          try {
            await authorizeTrustedMutation();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } finally {
            await cleanup();
          }
        }
        if (action.clear) {
          await authorizeTrustedMutation();
          await page.keyboard.press("ControlOrMeta+A");
          await authorizeTrustedMutation();
          await page.keyboard.press("Backspace");
        }
        await authorizeTrustedMutation();
        await page.keyboard.type(action.text, { delay: action.delayMs });
      };
      if (action.wait) {
        const waited = await runWithWait(
          page,
          { collect: () => perceive(page, { delta: true }, protocolVersion === 1) },
          action.wait,
          dispatchType
        );
        result.waitResult = waited.waitResult;
        applyPerception(result, waited.state, protocolVersion);
      } else await dispatchType();
      result.typed = { ref: action.ref ?? null, characters: Array.from(action.text).length };
      if (!result.stateId)
        applyPerception(result, await perceive(page, {}, protocolVersion === 1), protocolVersion);
      break;
    }

    case "focus":
    case "press":
    case "paste":
    case "scroll":
    case "select":
    case "check":
    case "uncheck":
    case "hover":
    case "drag": {
      const dispatch = async () => executePrimitive({
        page,
        action,
        timeoutMs: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
        resolve: async (ref) => resolveRef(page, ref),
        authorize: async (refs) => {
          await hooks.beforeTrustedInput?.();
          if (protocolVersion === 2) {
            const previousLatestStateId = getLatestStateId(page);
            const latest = await perceive(page, {}, false);
            for (const ref of refs.length > 0 ? refs : [undefined]) {
              result.warnings = [
                ...(result.warnings ?? []),
                ...validateObservedDecision(page, request.page, action, ref, latest, previousLatestStateId),
              ];
            }
            discardValidationState(page, latest.stateId, previousLatestStateId);
          }
          pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
        },
      });
      let summary: PrimitiveSummary;
      if (action.wait) {
        let dispatched: PrimitiveSummary | undefined;
        try {
          const waited = await runWithWait(
            page,
            { collect: () => perceive(page, { delta: true }, protocolVersion === 1) },
            action.wait,
            async () => { dispatched = await dispatch(); }
          );
          summary = dispatched!;
          const lastAttempt = summary.attemptJournal?.at(-1);
          if (lastAttempt) lastAttempt.sideEffects = mergeWaitEvents(lastAttempt.sideEffects, boundedWaitEvents(waited.waitResult.events));
          result.waitResult = waited.waitResult;
          applyPerception(result, waited.state, protocolVersion);
        } catch (error) {
          const journal = dispatched?.attemptJournal;
          const lastAttempt = journal?.at(-1);
          if (!journal || !lastAttempt) throw error;
          lastAttempt.sideEffects = mergeWaitEvents(lastAttempt.sideEffects, timeoutEvents(attemptError(error, page)));
          throw withAttemptJournal(attemptError(error, page), journal);
        }
      } else summary = await dispatch();
      Object.assign(result, summary);
      if (!result.stateId) applyPerception(result, await perceive(page, { delta: true }, protocolVersion === 1), protocolVersion);
      break;
    }

    case "confirm": {
      const text = action.expectText
        ? await requireExpectedText(page, action.expectText)
        : await readConfirmationText(page);
      result.confirmation = {
        confirmed: action.expectText ? true : false,
        expected: action.expectText ?? null,
        text,
      };
      break;
    }

    case "shot":
      break;
  }

  result.url = page.url();
  result.title = await page.title();
  if (!result.coordinateSpace) {
    applyPerception(
      result,
      await perceive(page, {}, protocolVersion === 1),
      protocolVersion,
      action.kind !== "find" || protocolVersion === 1
    );
  }

  if (request.shot || request.annotate || action.kind === "shot") {
    const name =
      request.shot && request.shot !== "auto" ? request.shot : automaticScreenshotName(action.kind);
    if (action.kind === "shot" && action.ref) {
      const resolved = await resolveRef(page, action.ref);
      try {
        await resolved.locator.scrollIntoViewIfNeeded({
          timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
        });
      } finally {
        await resolved.cleanup();
      }
    }
    const visualPerception = await perceive(page, { full: request.fullPage }, false);
    const focusElement =
      action.kind === "shot" && action.ref
        ? visualPerception.elements.find((element) => element.ref === action.ref)
        : undefined;
    if (action.kind === "shot" && action.ref && !focusElement) {
      throw new AgentProtocolError(
        "STALE_REF",
        `Element ref "${action.ref}" is stale or missing; run read again`,
        true,
        { details: { ref: action.ref }, nextCommands: ["dev-browser read"] }
      );
    }
    const matchRefs =
      action.kind === "find" ? new Set((result.matches ?? []).map((match) => match.ref)) : null;
    result.artifacts = await captureVisualArtifacts(page, visualPerception, {
      screenshotName: request.annotate ? undefined : name,
      annotatedName: request.annotate ? name : undefined,
      annotate: request.annotate,
      fullPage: request.fullPage,
      annotationElements: matchRefs
        ? visualPerception.elements.filter((element) => matchRefs.has(element.ref))
        : undefined,
      focus: focusElement
        ? { box: focusElement.box, padding: action.kind === "shot" ? (action.padding ?? 32) : 32 }
        : undefined,
    });
    result.screenshotPath =
      result.artifacts.annotatedScreenshot?.path ?? result.artifacts.screenshot?.path;
  }

  return result;
}
