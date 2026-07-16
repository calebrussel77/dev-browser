import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import {
  collectPageState,
  type CollectPageStateOptions,
  type PagePerception,
  type PerceptionElement,
} from "./perception/collector.js";
import type { InteractiveRequest } from "./protocol.js";
import { writeDevBrowserTempFile } from "./temp-files.js";

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
  };
  attempts?: number;
  waitForText?: string | null;
  waitSatisfied?: boolean | null;
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

async function savePageScreenshot(page: Page, requestedName: string): Promise<string> {
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  return await writeDevBrowserTempFile(
    requestedName,
    await page.screenshot({
      scale: "css",
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    })
  );
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
  result.warnings = perception.warnings;
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
    };
  });
  return { url: page.url(), snapshot: await snapshot(page), ...state };
}

function compareSignals(
  before: PageSignal,
  after: PageSignal
): NonNullable<InteractiveResult["change"]> {
  const change = {
    url: before.url !== after.url,
    snapshot: before.snapshot !== after.snapshot,
    dialog: JSON.stringify(before.dialogs) !== JSON.stringify(after.dialogs),
    ariaExpanded: JSON.stringify(before.ariaExpanded) !== JSON.stringify(after.ariaExpanded),
    any: false,
  };
  change.any = change.url || change.snapshot || change.dialog || change.ariaExpanded;
  return change;
}

async function visibleTextContains(page: Page, expected: string): Promise<boolean> {
  const actual = normalizeText(await page.locator("body").innerText());
  return actual.includes(normalizeText(expected));
}

async function waitForVisibleText(
  page: Page,
  expected: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await visibleTextContains(page, expected)) return true;
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return await visibleTextContains(page, expected);
}

export async function executeInteractiveAction(
  manager: BrowserManager,
  request: InteractiveRequest
): Promise<InteractiveResult> {
  const { action } = request;

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

  switch (action.kind) {
    case "navigate":
      await page.goto(action.url, {
        timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      applyPerception(result, await perceive(page, {}, protocolVersion === 1), protocolVersion);
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
      const clickOnce = async () => {
        if ("ref" in action) {
          const { box, locator, resolvedBy, cleanup } = await resolveRef(page, action.ref);
          const point = {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          };
          try {
            if (action.method === "locator") {
              await locator.click({ timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
            } else {
              await page.mouse.click(point.x, point.y);
            }
          } finally {
            await cleanup();
          }
          result.clicked = { ref: action.ref, method: action.method, point, resolvedBy };
        } else {
          await page.mouse.click(action.x, action.y);
          result.clicked = {
            ref: null,
            method: "mouse",
            point: { x: action.x, y: action.y },
            resolvedBy: "self",
          };
        }
      };

      let attempts = 1;
      await clickOnce();
      await page.waitForTimeout(CLICK_SETTLE_MS);
      let after = await pageSignal(page);
      let change = compareSignals(before, after);
      let waitSatisfied = action.waitForText
        ? await waitForVisibleText(
            page,
            action.waitForText,
            Math.min(request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, 5_000)
          )
        : null;

      if (action.waitForText && !waitSatisfied && !change.any && !action.expectText) {
        attempts = 2;
        await clickOnce();
        await page.waitForTimeout(CLICK_SETTLE_MS);
        waitSatisfied = await waitForVisibleText(
          page,
          action.waitForText,
          Math.min(request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, 5_000)
        );
        after = await pageSignal(page);
        change = compareSignals(before, after);
      }

      if (action.waitForText && !waitSatisfied) {
        const boundedWaitForText = summarizeErrorContext(action.waitForText);
        throw new AgentProtocolError(
          "WAIT_TIMEOUT",
          `--wait-for text "${boundedWaitForText}" was not observed after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
          true,
          {
            details: {
              attempts,
              waitForText: boundedWaitForText,
              waitForTextLength: action.waitForText.length,
            },
          }
        );
      }

      result.change = change;
      result.attempts = attempts;
      result.waitForText = action.waitForText ?? null;
      result.waitSatisfied = waitSatisfied;
      applyPerception(result, await perceive(page, {}, protocolVersion === 1), protocolVersion);
      break;
    }

    case "type": {
      if (action.ref) {
        const { box, cleanup } = await resolveRef(page, action.ref);
        try {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } finally {
          await cleanup();
        }
      }
      if (action.clear) {
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type(action.text, { delay: action.delayMs });
      result.typed = { ref: action.ref ?? null, characters: Array.from(action.text).length };
      applyPerception(result, await perceive(page, {}, protocolVersion === 1), protocolVersion);
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

  if (request.shot || action.kind === "shot") {
    const name =
      request.shot && request.shot !== "auto" ? request.shot : automaticScreenshotName(action.kind);
    result.screenshotPath = await savePageScreenshot(page, name);
  }

  return result;
}
