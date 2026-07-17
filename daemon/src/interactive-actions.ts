import { rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Download, Page } from "playwright";

import {
  actionTargetMetadata,
  resolveActionTarget,
  type ActionTargetMetadata,
  type ActionTargetOptions,
  type ResolvedActionTarget,
} from "./actionability.js";
import { AgentProtocolError } from "./agent-protocol.js";
import {
  attemptErrorReason,
  attemptFrameContext,
  boundedWaitEvents,
  emptyWaitEvents,
  mergeWaitEvents,
  originatingAttemptFrameContext,
  recordAttempt,
  trustedInputError as attemptError,
  unchangedAttempt,
  withAttemptJournal,
} from "./action-journal.js";
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
import { findTargets, type TargetAmbiguity, type TargetMatch } from "./targeting.js";
import { captureVisualArtifacts, type VisualArtifacts } from "./visual-artifacts.js";
import {
  capturedWaitEvents,
  capturePopupMetadata,
  runWithWait,
  type WaitEvents,
  type WaitResult,
} from "./wait-engine.js";
import { reserveUniqueDownloadFile, resolveControlledUploadFile } from "./temp-files.js";
import { observeRecoveryCommand } from "./recovery-command.js";
import { collectLiveSnapshot, describeLiveRef } from "./live-snapshot.js";
import { confirmationTokens, type ConfirmationScope } from "./confirmation-tokens.js";
import { redactSensitive } from "./redaction.js";

export type InteractiveElement = PerceptionElement;

export type InteractiveMatch = TargetMatch;

export interface InteractiveResult {
  action: InteractiveRequest["action"]["kind"];
  page: string;
  url?: string;
  title?: string;
  pages?: Awaited<ReturnType<BrowserManager["listPages"]>>;
  snapshot?: string;
  elements?: InteractiveElement[];
  matches?: InteractiveMatch[];
  ambiguity?: TargetAmbiguity;
  documentId?: string;
  stateId?: string;
  tree?: string;
  focusedRef?: string | null;
  delta?: PagePerception["delta"];
  warnings?: string[];
  truncation?: PagePerception["truncation"];
  clicked?: {
    ref: string | null;
    actualRef?: string | null;
    originalRef?: string | null;
    method: "mouse" | "locator";
    point: { x: number; y: number };
    resolvedBy?: "self" | "descendant" | "ancestor";
    actual?: { role: string; name: string; tag: string };
    box?: { x: number; y: number; width: number; height: number };
    scroll?: {
      scrolled: boolean;
      before: { x: number; y: number };
      after: { x: number; y: number };
    };
  };
  typed?: {
    ref: string | null;
    characters: number;
  } & Partial<ActionTargetMetadata>;
  targets?: ActionTargetMetadata[];
  confirmation?: {
    confirmed: boolean;
    expected?: "[redacted]" | null;
    text?: "[redacted]";
    issuedAt?: string;
    expiresAt?: string;
    ref?: string;
    actualRef?: string;
  };
  confirmationToken?: string;
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
  navigation?: {
    operation: "back" | "forward" | "reload";
    navigated: boolean;
    beforeUrl: string;
    afterUrl: string;
    beforeDocumentId?: string;
    afterDocumentId?: string;
    beforeStateId?: string;
    afterStateId?: string;
    nextCommand: string;
  };
  uploaded?: { ref: string; actualRef: string; filename: string; bytes: number; selected: boolean };
  download?: {
    filename: string;
    bytes: number;
    path: string;
    originatingAction: "click" | "press";
    page: string;
  };
  popup?: {
    targetId: string;
    url: string;
    title: string;
    openerPage: string;
    focusChanged: boolean;
    currentPageChanged: boolean;
    nextCommand: string;
  };
}

export interface ActionExecutionHooks {
  beforeTrustedInput?: () => void | Promise<void>;
}

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_READ_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 10;
const MAX_CONFIRMATION_TEXT_LENGTH = 8_000;
const MAX_ERROR_CONTEXT_LENGTH = 500;
const CLICK_SETTLE_MS = 100;
const PRESS_SETTLE_MS = 750;

function waitIncludes(wait: WaitSpec | undefined, kind: WaitSpec["conditions"][number]["kind"]): boolean {
  return Boolean(wait?.conditions.some((condition) => condition.kind === kind));
}

function compactWaitEvidence(waitResult: WaitResult | undefined, fallback?: unknown) {
  if (!waitResult) return fallback ?? null;
  return {
    mode: waitResult.mode,
    elapsedMs: waitResult.elapsedMs,
    passed: waitResult.passed.slice(0, 5),
    timedOut: waitResult.timedOut.slice(0, 5),
    observations: waitResult.observations.slice(0, 5),
    events: boundedWaitEvents(waitResult.events),
  };
}

function redactedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()])
      if (/token|auth|key|password|secret|session|code|credential/i.test(key) ||
          /(?:token|auth|key|password|secret|session|code|credential)\s*[:=]/i.test(url.searchParams.get(key) ?? ""))
        url.searchParams.set(key, "[redacted]");
    if (/(?:token|auth|key|password|secret|session|code|credential)[=:]/i.test(url.hash))
      url.hash = "#[redacted]";
    return url.toString().slice(0, 500);
  } catch {
    return value.slice(0, 500);
  }
}

function pageAwareTrustedInputError(
  error: unknown,
  page: Page,
  pageName: string
): AgentProtocolError {
  const typed = attemptError(error, page);
  if (
    (typed.code === "PAGE_CLOSED" || typed.code === "FRAME_DETACHED") &&
    !(typed.nextCommands?.length)
  ) {
    return new AgentProtocolError(typed.code, typed.message, typed.recoverable, {
      details: typed.details,
      nextCommands: [observeRecoveryCommand(pageName)],
    });
  }
  return typed;
}

async function saveDownload(
  download: Download,
  action: "click" | "press",
  pageName: string,
  journal: AttemptJournalEntry[]
) {
  const startedAt = new Date().toISOString();
  let reserved: Awaited<ReturnType<typeof reserveUniqueDownloadFile>> | undefined;
  try {
    reserved = await reserveUniqueDownloadFile(download.suggestedFilename());
    if (await download.failure()) throw new Error("interrupted");
    const stream = await download.createReadStream();
    if (!stream) throw new Error("download stream unavailable");
    const heldHandle = reserved.handle;
    await pipeline(stream, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        void (async () => {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await heldHandle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              null
            );
            if (bytesWritten <= 0) throw new Error("Download destination stopped accepting bytes");
            offset += bytesWritten;
          }
        })().then(() => callback(), callback);
      },
    }));
    const saved = await reserved.handle.stat();
    if (!saved.isFile()) throw new Error("not a regular file");
    recordAttempt(journal, {
      attempt: journal.length + 1,
      startedAt,
      inputMethod: "download",
      sideEffects: emptyWaitEvents(),
      change: unchangedAttempt(),
      retryDecision: "stop",
      reason: "artifact-saved",
    }, originatingAttemptFrameContext(journal));
    return {
      filename: reserved.filename,
      bytes: saved.size,
      path: reserved.path,
      originatingAction: action,
      page: pageName,
    };
  } catch {
    recordAttempt(journal, {
      attempt: journal.length + 1,
      startedAt,
      inputMethod: "download",
      sideEffects: emptyWaitEvents(),
      change: unchangedAttempt(),
      retryDecision: "stop",
      reason: "download-failed",
    }, originatingAttemptFrameContext(journal));
    throw withAttemptJournal(new AgentProtocolError("DOWNLOAD_FAILED", "Download could not be saved safely", true, {
      nextCommands: [observeRecoveryCommand(pageName)],
    }), journal);
  } finally {
    await reserved?.handle.close().catch(() => undefined);
    if (reserved && journal.at(-1)?.reason === "download-failed")
      await rm(reserved.path, { force: true }).catch(() => undefined);
  }
}

async function buildPopupResult(
  manager: BrowserManager,
  browser: string,
  openerPage: string,
  popup: Page,
  metadata: WaitEvents["popup"][number] | undefined
) {
  try {
    if (!metadata?.targetId || metadata.warning)
      throw new Error("Popup metadata deadline expired");
    manager.registerKnownPageTarget(browser, metadata.targetId, popup);
    const focused = await Promise.race([
      popup.evaluate(() => document.hasFocus()).catch(() => false),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    return {
      targetId: metadata.targetId,
      url: metadata.url,
      title: metadata.title,
      openerPage,
      focusChanged: focused,
      currentPageChanged: manager.isNamedPage(browser, openerPage, popup),
      nextCommand: observeRecoveryCommand(metadata.targetId),
    };
  } catch {
    throw new AgentProtocolError("POPUP_OPENED", "Popup opened but metadata was unavailable", true, {
      nextCommands: ["dev-browser pages", observeRecoveryCommand(openerPage)],
    });
  }
}

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

async function resolveRef(page: Page, ref: string, options: Partial<ActionTargetOptions> = {}) {
  return resolveActionTarget(page, ref, {
    timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    scroll: options.scroll ?? false,
    hitTest: options.hitTest ?? false,
    applicability: options.applicability ?? "pointer",
    pageName: options.pageName,
    legacyRefs: options.legacyRefs,
  });
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
    throw new AgentProtocolError(
      "CONFIRMATION_INVALID",
      "Current confirmation text does not match the expected recipient or action",
      true
    );
  }
  return text;
}

function confirmationScope(
  request: InteractiveRequest,
  page: Page,
  resolved: ResolvedActionTarget,
  expectedText: string,
  confirmationText: string,
  stateId: string
): ConfirmationScope {
  return {
    browser: request.browser,
    pageName: request.page,
    page,
    documentId: stateId.split(":", 1)[0]!,
    stateId,
    originalRef: resolved.originalRef,
    resolvedRef: resolved.actualRef,
    targetFingerprint: JSON.stringify({
      actualRef: resolved.actualRef,
      resolvedBy: resolved.resolvedBy,
      actual: resolved.actual,
      frameId: resolved.frameId,
      framePath: resolved.framePath,
      shadowContext: resolved.shadowContext,
    }),
    frameId: resolved.frameId ?? "F0",
    framePath: resolved.framePath ?? ["F0"],
    shadowContext: resolved.shadowContext ?? [],
    expectedText,
    confirmationText,
    url: page.url(),
  };
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
  truncated: boolean;
}

async function pageSignal(page: Page): Promise<PageSignal> {
  const live = await collectLiveSnapshot(page);
  return {
    url: page.url(),
    snapshot: JSON.stringify(live.frameSignals.map(({ frameId, url, dom }) => ({ frameId, url, dom }))).slice(0, 12_000),
    dialogs: live.dialogs,
    ariaExpanded: Object.entries(live.refs).filter(([, value]) => value.states.expanded !== "").map(([ref, value]) => `${ref}:${value.states.expanded}`),
    dom: JSON.stringify(live.frameSignals).slice(0, 24_000),
    focus: live.frameSignals.map((frame) => `${frame.frameId}:${frame.focus}`).join("|").slice(0, 2_000),
    values: Object.entries(live.refs).map(([ref, value]) => `${ref}:${value.value}`).slice(0, 2_000),
    truncated: live.truncated,
  };
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
    coverageTruncated: before.truncated || after.truncated,
    any: false,
  };
  change.any =
    before.truncated ||
    after.truncated ||
    change.url ||
    change.snapshot ||
    change.dialog ||
    change.ariaExpanded ||
    change.dom ||
    change.focus ||
    change.value;
  return change;
}

function addFrameSignalEvidence(events: WaitEvents, change: AttemptChange, context: AttemptJournalEntry["frameContext"]): void {
  if (!context || context.frameId === "F0") return;
  if ((change.dom || change.snapshot) && events.mutations.length === 0)
    events.mutations.push({ type: "frame-state", target: `${context.frameId}:${context.ref ?? "document"}`.slice(0, 160) });
  if (change.value && events.valueChanges.length === 0)
    events.valueChanges.push({ type: "frame-value", target: `${context.frameId}:${context.ref ?? "document"}`.slice(0, 160) });
  if (change.focus && events.focusChanges.length === 0)
    events.focusChanges.push({ type: "frame-focus", target: `${context.frameId}:${context.ref ?? "document"}`.slice(0, 160) });
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
  const descriptor = "ref" in action ? await describeLiveRef(page, action.ref) : await page.evaluate((target) => {
    const element = document.elementFromPoint(target.x, target.y);
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
    throw new AgentProtocolError(
      "UNSUPPORTED_CONTEXT",
      "Paste cannot create screenshots or annotations",
      false
    );
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
  const sensitiveValues: string[] = [];

  const authorizeTrustedMutation = async () => {
    await hooks.beforeTrustedInput?.();
    pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
  };

  const validateDecisionRefs = async (refs: Array<string | undefined>) => {
    if (protocolVersion !== 2) return;
    const previousLatestStateId = getLatestStateId(page);
    const latest = await perceive(page, {}, false);
    try {
      for (const ref of refs) {
        result.warnings = [
          ...(result.warnings ?? []),
          ...validateObservedDecision(
            page,
            request.page,
            action,
            ref,
            latest,
            previousLatestStateId
          ),
        ];
      }
    } finally {
      discardValidationState(page, latest.stateId, previousLatestStateId);
    }
  };

  if (protocolVersion === 2 && (action.kind === "type" || (action.kind === "shot" && action.ref))) {
    await validateDecisionRefs(["ref" in action ? action.ref : undefined]);
  }

  switch (action.kind) {
    case "navigate":
      if (action.wait) {
        const waited = await runWithWait(
          page,
          { collect: () => perceive(page, { delta: true }, protocolVersion === 1), protocolVersion },
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

    case "back":
    case "forward":
    case "reload": {
      const startedAt = new Date().toISOString();
      await validateDecisionRefs([undefined]);
      const beforeStateId = getLatestStateId(page) ?? undefined;
      const beforeDocumentId = beforeStateId?.split(":", 1)[0];
      const beforeUrl = redactedUrl(page.url());
      let operationResponse: unknown = null;
      const dispatch = async () => {
        await hooks.beforeTrustedInput?.();
        await validateDecisionRefs([undefined]);
        pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
        if (action.kind === "back")
          operationResponse = await page.goBack({ timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        else if (action.kind === "forward")
          operationResponse = await page.goForward({ timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        else operationResponse = await page.reload({ timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
        return operationResponse;
      };
      let navigated = false;
      let sideEffects = emptyWaitEvents();
      try {
        if (action.wait) {
          const waited = await runWithWait(
            page,
            { collect: () => perceive(page, { delta: true }, protocolVersion === 1), protocolVersion },
            action.wait,
            dispatch
          );
          result.waitResult = waited.waitResult;
          sideEffects = boundedWaitEvents(waited.waitResult.events);
          applyPerception(result, waited.state, protocolVersion);
        } else {
          await dispatch();
          applyPerception(result, await perceive(page, { delta: true }, protocolVersion === 1), protocolVersion);
        }
      } catch (error) {
        const typed = pageAwareTrustedInputError(error, page, request.page);
        const failureJournal: AttemptJournalEntry[] = [{
          attempt: 1, startedAt, inputMethod: "navigation",
          sideEffects: boundedWaitEvents(capturedWaitEvents(error) ?? emptyWaitEvents()),
          change: unchangedAttempt(), retryDecision: "stop", reason: attemptErrorReason(typed),
        }];
        throw withAttemptJournal(typed, failureJournal);
      }
      const afterUrl = redactedUrl(page.url());
      const documentChanged = Boolean(
        beforeDocumentId && result.documentId && beforeDocumentId !== result.documentId
      );
      navigated = beforeUrl !== afterUrl || documentChanged || operationResponse !== null;
      result.navigation = {
        operation: action.kind,
        navigated,
        beforeUrl,
        afterUrl,
        beforeDocumentId,
        afterDocumentId: result.documentId,
        beforeStateId,
        afterStateId: result.stateId,
        nextCommand: observeRecoveryCommand(request.page),
      };
      result.attempts = 1;
      result.attemptJournal = [{
        attempt: 1,
        startedAt,
        inputMethod: "navigation",
        sideEffects,
        change: { ...unchangedAttempt(), any: navigated, url: beforeUrl !== afterUrl, snapshot: documentChanged, dom: Boolean(beforeStateId && beforeStateId !== result.stateId) },
        retryDecision: "stop",
        reason: navigated ? "action-complete" : "no-history-entry",
        frameContext: attemptFrameContext(),
      }];
      break;
    }

    case "upload": {
      const startedAt = new Date().toISOString();
      const uploadJournal: AttemptJournalEntry[] = [];
      let resolved: ResolvedActionTarget | undefined;
      const failUpload = (error: AgentProtocolError, reason: string): never => {
        recordAttempt(uploadJournal, {
          attempt: 1, startedAt, inputMethod: "upload", sideEffects: emptyWaitEvents(),
          change: unchangedAttempt(), retryDecision: "stop", reason,
          frameContext: attemptFrameContext(action.ref, resolved),
        });
        throw withAttemptJournal(error, uploadJournal);
      };
      if (action.wait?.conditions.some((condition) => condition.kind === "fileChooser"))
        failUpload(new AgentProtocolError(
          "UNSUPPORTED_CONTEXT",
          "Upload uses direct file assignment and cannot wait for a file chooser; no file was selected",
          true,
          { nextCommands: [observeRecoveryCommand(request.page)] }
        ), "unsupported-file-chooser-wait");
      const controlled = await resolveControlledUploadFile(action.file).catch(() =>
        failUpload(new AgentProtocolError(
          "UNSUPPORTED_CONTEXT",
          "Upload requires a regular file inside the controlled dev-browser temp directory",
          true,
          { nextCommands: [observeRecoveryCommand(request.page)] }
        ), "unsafe-upload-source")
      );
      await validateDecisionRefs([action.ref]);
      const dispatch = async () => {
        await hooks.beforeTrustedInput?.();
        resolved = await resolveRef(page, action.ref, {
          pageName: request.page,
          timeoutMs: request.timeoutMs,
          scroll: false,
          hitTest: true,
          applicability: "upload",
          legacyRefs: protocolVersion === 1,
        });
        await validateDecisionRefs([action.ref]);
        pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
        if (action.confirmToken) {
          if (!action.fromState)
            throw new AgentProtocolError("CONFIRMATION_INVALID", "Confirmation token requires its issued state and ref target", true);
          confirmationTokens.consume(action.confirmToken, confirmationScope(
            request, page, resolved, "", await readConfirmationText(page), action.fromState
          ));
        }
        await resolved.locator.setInputFiles({
          name: controlled.filename,
          mimeType: "application/octet-stream",
          buffer: controlled.buffer,
        }, {
          timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
        });
      };
      try {
        let sideEffects = emptyWaitEvents();
        if (action.wait) {
          const waited = await runWithWait(
            page,
            { collect: () => perceive(page, { delta: true }, protocolVersion === 1), protocolVersion },
            action.wait,
            dispatch
          );
          result.waitResult = waited.waitResult;
          sideEffects = boundedWaitEvents(waited.waitResult.events);
          applyPerception(result, waited.state, protocolVersion);
        } else await dispatch();
        result.uploaded = {
          ref: action.ref,
          actualRef: resolved!.actualRef,
          filename: controlled.filename,
          bytes: controlled.bytes,
          selected: true,
        };
        result.targets = [actionTargetMetadata(resolved!, "upload")];
        result.attempts = 1;
        recordAttempt(uploadJournal, {
          attempt: 1,
          startedAt,
          inputMethod: "upload",
          sideEffects,
          change: { ...unchangedAttempt(), any: true, value: true },
          retryDecision: "stop",
          reason: "action-complete",
          frameContext: attemptFrameContext(action.ref, resolved),
        });
        result.attemptJournal = uploadJournal;
      } catch (error) {
        const typed = pageAwareTrustedInputError(error, page, request.page);
        if (uploadJournal.length === 0)
          recordAttempt(uploadJournal, {
            attempt: 1, startedAt, inputMethod: "upload",
            sideEffects: boundedWaitEvents(capturedWaitEvents(error) ?? emptyWaitEvents()),
            change: unchangedAttempt(), retryDecision: "stop", reason: attemptErrorReason(typed),
            frameContext: attemptFrameContext(action.ref, resolved),
          });
        throw withAttemptJournal(typed, uploadJournal);
      } finally {
        await resolved?.cleanup();
      }
      if (!result.stateId)
        applyPerception(result, await perceive(page, { delta: true }, protocolVersion === 1), protocolVersion);
      break;
    }

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
      const targeted = findTargets(
        perception.elements.filter((element) => element.actionable),
        {
          query: action.query,
          role: action.role,
          name: action.name,
          nameMode: action.nameMode,
          within: action.within,
          near: action.near,
          frame: action.frame,
          scope: action.scope ?? "visible",
          states: action.states ?? [],
          index: action.index,
        },
        action.limit ?? DEFAULT_FIND_LIMIT
      );
      result.matches = targeted.matches;
      result.ambiguity = targeted.ambiguity;
      break;
    }

    case "click": {
      const openedPopups: Page[] = [];
      const startedDownloads: Download[] = [];
      if (action.confirmToken && !("ref" in action))
        throw new AgentProtocolError("CONFIRMATION_INVALID", "Confirmation tokens require a ref target", true);
      if (action.expectText) {
        await requireExpectedText(page, action.expectText);
      }
      const before = await pageSignal(page);
      const revalidateClick = async () => {
        await validateDecisionRefs(["ref" in action ? action.ref : undefined]);
      };
      let confirmationConsumed = false;
      const prepareClickInput = async (resolved?: ResolvedActionTarget) => {
        await hooks.beforeTrustedInput?.();
        await revalidateClick();
        pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
        if (action.confirmToken && !confirmationConsumed) {
          if (!resolved || !action.fromState)
            throw new AgentProtocolError("CONFIRMATION_INVALID", "Confirmation token requires its issued state and ref target", true);
          const confirmationText = await readConfirmationText(page);
          confirmationTokens.consume(action.confirmToken, confirmationScope(
            request, page, resolved, "", confirmationText, action.fromState
          ));
          confirmationConsumed = true;
        }
      };
      let clickFrameContext: AttemptJournalEntry["frameContext"] = attemptFrameContext("ref" in action ? action.ref : null);
      const clickOnce = async () => {
        if ("ref" in action) {
          // Validate the observed decision before resolving the live element.
          // The validation is repeated immediately before trusted input below.
          await revalidateClick();
          const resolved = await resolveRef(page, action.ref, {
            pageName: request.page,
            timeoutMs: request.timeoutMs,
            scroll: true,
            hitTest: true,
            applicability: "pointer",
            legacyRefs: protocolVersion === 1,
          });
          const { box, locator, resolvedBy, cleanup } = resolved;
          clickFrameContext = attemptFrameContext(action.ref, resolved);
          const point = {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          };
          try {
            if (action.method === "locator") {
              await prepareClickInput(resolved);
              await locator.click({ timeout: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
            } else {
              await prepareClickInput(resolved);
              await page.mouse.click(point.x, point.y);
            }
          } finally {
            await cleanup();
          }
          result.clicked = {
            ref: resolved.actualRef,
            actualRef: resolved.actualRef,
            originalRef: resolved.originalRef,
            method: action.method,
            point,
            resolvedBy,
            actual: resolved.actual,
            box: resolved.box,
            scroll: resolved.scroll,
          };
          result.targets = [actionTargetMetadata(resolved, action.method)];
        } else {
          await prepareClickInput();
          await page.mouse.click(action.x, action.y);
          result.clicked = {
            ref: null,
            originalRef: null,
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
        let resolveOuterPopup: (() => void) | undefined;
        const outerPopupArrived = new Promise<void>((resolve) => { resolveOuterPopup = resolve; });
        const onOuterPopup = (popup: Page) => {
          if (!openedPopups.includes(popup)) openedPopups.push(popup);
          resolveOuterPopup?.();
        };
        page.on("popup", onOuterPopup);
        const finishOuterPopupCapture = () => page.off("popup", onOuterPopup);
        try {
          attemptBefore = await pageSignal(page);
          const monitoringWait: WaitSpec = wait ?? {
            mode: "all",
            timeoutMs: PRESS_SETTLE_MS,
            conditions: [{ kind: "networkIdle", specialized: true, idleMs: 700 }],
          };
          const waited = await runWithWait(
            page,
            {
              collect: () => perceive(page, { delta: true }, protocolVersion === 1),
              protocolVersion,
              onPopup: (popup) => openedPopups.push(popup),
              onDownload: (download) => startedDownloads.push(download),
            },
            monitoringWait,
            clickOnce
          );
          if (wait && !waitIncludes(wait, "popup") && !openedPopups[0])
            await Promise.race([
              outerPopupArrived,
              new Promise<void>((resolve) => setTimeout(resolve, PRESS_SETTLE_MS)),
            ]);
          finishOuterPopupCapture();
          if (openedPopups[0] && waited.waitResult.events.popup.length === 0)
            waited.waitResult.events.popup.push(
              await capturePopupMetadata(openedPopups[0], page.url())
            );
          after = await pageSignal(page);
          const successfulChange = compareSignals(attemptBefore, after);
          addFrameSignalEvidence(waited.waitResult.events, successfulChange, clickFrameContext);
          recordAttempt(journal, {
            attempt,
            startedAt,
            inputMethod: action.method,
            frameContext: clickFrameContext,
            sideEffects: waited.waitResult.events,
            change: successfulChange,
            retryDecision: "stop",
            reason: wait ? "wait-satisfied" : "action-complete",
          }, originatingAttemptFrameContext(journal));
          if (wait && !waitIncludes(wait, "popup") && openedPopups[0]) {
            const popup = await buildPopupResult(
              manager, request.browser, request.page, openedPopups[0], waited.waitResult.events.popup[0]
            );
            throw withAttemptJournal(new AgentProtocolError(
              "POPUP_OPENED",
              "Popup opened while waiting for a different outcome",
              true,
              { details: { popup, waitResult: compactWaitEvidence(waited.waitResult) }, nextCommands: [popup.nextCommand] }
            ), journal);
          }
          result.waitResult = wait ? waited.waitResult : undefined;
          applyPerception(result, waited.state, protocolVersion);
          break;
        } catch (error) {
          if (wait && !waitIncludes(wait, "popup") && !openedPopups[0])
            await Promise.race([
              outerPopupArrived,
              new Promise<void>((resolve) => setTimeout(resolve, PRESS_SETTLE_MS)),
            ]);
          finishOuterPopupCapture();
          const captured = capturedWaitEvents(error) ??
            (error instanceof AgentProtocolError ? timeoutEvents(error) : emptyWaitEvents());
          if (openedPopups[0] && captured.popup.length === 0)
            captured.popup.push(await capturePopupMetadata(openedPopups[0], page.url()));
          const sideEffects = boundedWaitEvents(
            captured
          );
          const typedError = attemptError(error, page);
          if (typedError.code === "WAIT_TIMEOUT")
            await new Promise<void>((resolve) => setTimeout(resolve, 150));
          after = await pageSignal(page).catch(() => attemptBefore);
          const change = compareSignals(attemptBefore, after);
          addFrameSignalEvidence(sideEffects, change, clickFrameContext);
          if (wait && !waitIncludes(wait, "popup") && sideEffects.popup[0] && openedPopups[0]) {
            recordAttempt(journal, {
              attempt, startedAt, inputMethod: action.method, frameContext: clickFrameContext, sideEffects, change,
              retryDecision: "stop", reason: "unexpected-popup",
            });
            const popup = await buildPopupResult(
              manager, request.browser, request.page, openedPopups[0], sideEffects.popup[0]
            );
            throw withAttemptJournal(new AgentProtocolError(
              "POPUP_OPENED",
              "Popup opened while waiting for a different outcome",
              true,
              { details: { popup, waitResult: compactWaitEvidence(undefined, typedError.details) }, nextCommands: [popup.nextCommand] }
            ), journal);
          }
          if (!wait && typedError.code === "WAIT_TIMEOUT") {
            recordAttempt(journal, {
              attempt,
              startedAt,
              inputMethod: action.method,
              frameContext: clickFrameContext,
              sideEffects,
              change,
              retryDecision: "stop",
              reason: "action-complete",
            });
            break;
          }
          if (typedError.code !== "WAIT_TIMEOUT") {
            recordAttempt(journal, {
              attempt,
              startedAt,
              inputMethod: action.method,
              frameContext: clickFrameContext,
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
            guarded: Boolean(action.expectText || action.confirmToken),
            irreversibleIntent,
            sideEffects,
            change,
          });
          recordAttempt(journal, {
            attempt,
            startedAt,
            inputMethod: action.method,
            frameContext: clickFrameContext,
            sideEffects,
            change,
            ...decision,
          }, originatingAttemptFrameContext(journal));
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
      if (startedDownloads[0])
        result.download = await saveDownload(startedDownloads[0], "click", request.page, journal);
      if (openedPopups[0])
        try {
          result.popup = await buildPopupResult(
            manager,
            request.browser,
            request.page,
            openedPopups[0],
            journal.flatMap((entry) => entry.sideEffects.popup)[0]
          );
        } catch (error) {
          const typed = attemptError(error, page);
          recordAttempt(journal, {
            attempt: journal.length + 1, startedAt: new Date().toISOString(), inputMethod: "popup",
            sideEffects: emptyWaitEvents(), change: unchangedAttempt(), retryDecision: "stop",
            reason: "popup-metadata-unavailable",
          }, originatingAttemptFrameContext(journal));
          throw withAttemptJournal(typed, journal);
        }
      break;
    }

    case "type": {
      const journal: AttemptJournalEntry[] = [];
      let resolvedTypeTarget: ResolvedActionTarget | undefined;
      let typeConfirmationConsumed = false;
      const typeEntry = (
        method: AttemptJournalEntry["inputMethod"],
        reason: string,
        startedAt: string
      ): AttemptJournalEntry => ({
        attempt: journal.length + 1,
        startedAt,
        inputMethod: method,
        sideEffects: emptyWaitEvents(),
        change: unchangedAttempt(),
        retryDecision: "stop",
        reason,
        frameContext: attemptFrameContext(action.ref ?? null, resolvedTypeTarget),
      });
      const dispatchTypeInput = async (
        method: "mouse" | "keyboard",
        input: () => Promise<void>
      ) => {
        const startedAt = new Date().toISOString();
        try {
          await hooks.beforeTrustedInput?.();
          await validateDecisionRefs([action.ref]);
          pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
          if (action.confirmToken && !typeConfirmationConsumed) {
            if (!resolvedTypeTarget || !action.fromState)
              throw new AgentProtocolError("CONFIRMATION_INVALID", "Confirmation token requires its issued state and ref target", true);
            confirmationTokens.consume(action.confirmToken, confirmationScope(
              request, page, resolvedTypeTarget, "", await readConfirmationText(page), action.fromState
            ));
            typeConfirmationConsumed = true;
          }
          await input();
          recordAttempt(journal, typeEntry(method, "action-complete", startedAt));
        } catch (error) {
          const typed = attemptError(error, page);
          recordAttempt(journal, typeEntry(method, attemptErrorReason(typed), startedAt));
          throw withAttemptJournal(typed, journal);
        }
      };
      const dispatchType = async () => {
        if (action.ref) {
          const resolved = await resolveRef(page, action.ref, {
            pageName: request.page,
            timeoutMs: request.timeoutMs,
            scroll: true,
            hitTest: true,
            applicability: "type",
            legacyRefs: protocolVersion === 1,
          });
          resolvedTypeTarget = resolved;
          if (await resolved.locator.evaluate((element) =>
            element instanceof HTMLInputElement &&
            (element.type === "password" || /password|secret|token|credential/i.test(element.autocomplete || element.name || element.id))
          ).catch(() => false)) sensitiveValues.push(action.text);
          const { box, cleanup } = resolved;
          try {
            await dispatchTypeInput("mouse", () =>
              page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            );
          } finally {
            await cleanup();
          }
        }
        if (action.clear) {
          await dispatchTypeInput("keyboard", () => page.keyboard.press("ControlOrMeta+A"));
          await dispatchTypeInput("keyboard", () => page.keyboard.press("Backspace"));
        }
        await dispatchTypeInput("keyboard", () =>
          page.keyboard.type(action.text, { delay: action.delayMs })
        );
      };
      if (action.wait) {
        const waited = await runWithWait(
          page,
          { collect: () => perceive(page, { delta: true }, protocolVersion === 1), protocolVersion },
          action.wait,
          dispatchType
        );
        result.waitResult = waited.waitResult;
        applyPerception(result, waited.state, protocolVersion);
      } else await dispatchType();
      const typeTarget = resolvedTypeTarget
        ? actionTargetMetadata(resolvedTypeTarget, "keyboard")
        : undefined;
      result.typed = {
        ref: typeTarget?.actualRef ?? null,
        characters: Array.from(action.text).length,
        ...typeTarget,
      };
      result.targets = typeTarget ? [typeTarget] : undefined;
      result.attemptJournal = journal;
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
      const openedPopups: Page[] = [];
      const startedDownloads: Download[] = [];
      const primitiveRefs =
        action.kind === "drag"
          ? [action.from, action.to]
          : action.kind === "scroll"
            ? [action.ref]
            : [action.ref];
      let primitiveConfirmationConsumed = false;
      const dispatch = async () => {
        await validateDecisionRefs(primitiveRefs);
        return executePrimitive({
          page,
          action,
          timeoutMs: request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
          resolve: async (ref, role) => {
            const applicability =
              action.kind === "focus"
                ? "focus"
                : action.kind === "press"
                  ? "keyboard"
                  : action.kind === "paste"
                    ? "paste"
                    : action.kind === "select"
                      ? "select"
                      : action.kind === "check" || action.kind === "uncheck"
                        ? "check"
                        : action.kind === "drag"
                          ? role === "source"
                            ? "drag-source"
                            : "drop-target"
                          : "pointer";
            return resolveRef(page, ref, {
              pageName: request.page,
              timeoutMs: request.timeoutMs,
              scroll: action.kind !== "scroll",
              hitTest: action.kind === "hover" || action.kind === "drag",
              applicability,
              legacyRefs: protocolVersion === 1,
            });
          },
          authorize: async (refs, targets) => {
            await hooks.beforeTrustedInput?.();
            await validateDecisionRefs(refs.length > 0 ? refs : [undefined]);
            pageLeases.assertMutationAllowed(request.browser, request.page, request.session);
            if (action.confirmToken && !primitiveConfirmationConsumed) {
              if (!targets[0] || !action.fromState)
                throw new AgentProtocolError("CONFIRMATION_INVALID", "Confirmation token requires its issued state and ref target", true);
              confirmationTokens.consume(action.confirmToken, confirmationScope(
                request, page, targets[0], "", await readConfirmationText(page), action.fromState
              ));
              primitiveConfirmationConsumed = true;
            }
          },
        });
      };
      let summary: PrimitiveSummary;
      const primitiveWait: WaitSpec | undefined = action.wait ??
        (action.kind === "press"
          ? { mode: "all", timeoutMs: PRESS_SETTLE_MS, conditions: [{ kind: "networkIdle", specialized: true, idleMs: 700 }] }
          : undefined);
      let resolveOuterPrimitivePopup: (() => void) | undefined;
      const outerPrimitivePopupArrived = new Promise<void>((resolve) => {
        resolveOuterPrimitivePopup = resolve;
      });
      const onOuterPrimitivePopup = (popup: Page) => {
        if (!openedPopups.includes(popup)) openedPopups.push(popup);
        resolveOuterPrimitivePopup?.();
      };
      if (action.kind === "press") page.on("popup", onOuterPrimitivePopup);
      const finishOuterPrimitivePopupCapture = () => {
        if (action.kind === "press") page.off("popup", onOuterPrimitivePopup);
      };
      if (primitiveWait) {
        let dispatched: PrimitiveSummary | undefined;
        try {
          const waited = await runWithWait(
            page,
            {
              collect: () => perceive(page, { delta: true }, protocolVersion === 1),
              protocolVersion,
              onPopup: (popup) => openedPopups.push(popup),
              onDownload: (download) => startedDownloads.push(download),
            },
            primitiveWait,
            async () => {
              dispatched = await dispatch();
            }
          );
          if (action.wait && !waitIncludes(action.wait, "popup") && !openedPopups[0])
            await Promise.race([
              outerPrimitivePopupArrived,
              new Promise<void>((resolve) => setTimeout(resolve, PRESS_SETTLE_MS)),
            ]);
          finishOuterPrimitivePopupCapture();
          if (openedPopups[0] && waited.waitResult.events.popup.length === 0)
            waited.waitResult.events.popup.push(
              await capturePopupMetadata(openedPopups[0], page.url())
            );
          summary = dispatched!;
          const lastAttempt = summary.attemptJournal?.at(-1);
          if (lastAttempt)
            lastAttempt.sideEffects = mergeWaitEvents(
              lastAttempt.sideEffects,
              boundedWaitEvents(waited.waitResult.events)
            );
          if (action.wait && !waitIncludes(action.wait, "popup") && openedPopups[0]) {
            const popup = await buildPopupResult(
              manager, request.browser, request.page, openedPopups[0], waited.waitResult.events.popup[0]
            );
            throw new AgentProtocolError(
              "POPUP_OPENED",
              "Popup opened while waiting for a different outcome",
              true,
              { details: { popup, waitResult: compactWaitEvidence(waited.waitResult) }, nextCommands: [popup.nextCommand] }
            );
          }
          result.waitResult = action.wait ? waited.waitResult : undefined;
          applyPerception(result, waited.state, protocolVersion);
        } catch (error) {
          if (action.wait && !waitIncludes(action.wait, "popup") && !openedPopups[0])
            await Promise.race([
              outerPrimitivePopupArrived,
              new Promise<void>((resolve) => setTimeout(resolve, PRESS_SETTLE_MS)),
            ]);
          finishOuterPrimitivePopupCapture();
          const journal = dispatched?.attemptJournal;
          const lastAttempt = journal?.at(-1);
          if (!journal || !lastAttempt) throw error;
          const captured = capturedWaitEvents(error) ?? timeoutEvents(attemptError(error, page));
          if (openedPopups[0] && captured.popup.length === 0)
            captured.popup.push(await capturePopupMetadata(openedPopups[0], page.url()));
          lastAttempt.sideEffects = mergeWaitEvents(
            lastAttempt.sideEffects,
            boundedWaitEvents(captured)
          );
          if (action.wait && !waitIncludes(action.wait, "popup") && openedPopups[0]) {
            const popup = await buildPopupResult(
              manager, request.browser, request.page, openedPopups[0], lastAttempt.sideEffects.popup[0]
            );
            throw withAttemptJournal(new AgentProtocolError(
              "POPUP_OPENED",
              "Popup opened while waiting for a different outcome",
              true,
              { details: { popup, waitResult: compactWaitEvidence(undefined, (error as AgentProtocolError).details) }, nextCommands: [popup.nextCommand] }
            ), journal);
          }
          throw withAttemptJournal(attemptError(error, page), journal);
        }
      } else {
        try {
          summary = await dispatch();
        } finally {
          finishOuterPrimitivePopupCapture();
        }
      }
      Object.assign(result, summary);
      if (action.kind === "press" && startedDownloads[0])
        result.download = await saveDownload(
          startedDownloads[0],
          "press",
          request.page,
          summary.attemptJournal ?? []
        );
      if (action.kind === "press" && openedPopups[0])
        try {
          result.popup = await buildPopupResult(
            manager,
            request.browser,
            request.page,
            openedPopups[0],
            summary.attemptJournal?.flatMap((entry) => entry.sideEffects.popup)[0]
          );
        } catch (error) {
          const journal = summary.attemptJournal ?? [];
          recordAttempt(journal, {
            attempt: journal.length + 1, startedAt: new Date().toISOString(), inputMethod: "popup",
            sideEffects: emptyWaitEvents(), change: unchangedAttempt(), retryDecision: "stop",
            reason: "popup-metadata-unavailable",
          }, originatingAttemptFrameContext(journal));
          throw withAttemptJournal(attemptError(error, page), journal);
        }
      if (!result.stateId)
        applyPerception(
          result,
          await perceive(page, { delta: true }, protocolVersion === 1),
          protocolVersion
        );
      break;
    }

    case "confirm": {
      if (protocolVersion === 2) {
        if (!action.expectText || !action.ref)
          throw new AgentProtocolError("CONFIRMATION_INVALID", "Protocol v2 confirmation requires --ref and --expect", true);
        await validateDecisionRefs([action.ref]);
        const text = await requireExpectedText(page, action.expectText);
        const perception = await perceive(page, {}, false);
        applyPerception(result, perception, protocolVersion);
        const resolved = await resolveRef(page, action.ref, {
          pageName: request.page, timeoutMs: request.timeoutMs, scroll: false,
          hitTest: false, applicability: "pointer", legacyRefs: false,
        });
        try {
          const issued = confirmationTokens.issue(confirmationScope(
            request, page, resolved, action.expectText, text, perception.stateId
          ));
          result.confirmationToken = issued.confirmationToken;
          result.confirmation = {
            confirmed: true,
            issuedAt: issued.issuedAt,
            expiresAt: issued.expiresAt,
            ref: action.ref,
            actualRef: resolved.actualRef,
          };
        } finally { await resolved.cleanup(); }
      } else {
        if (action.expectText) await requireExpectedText(page, action.expectText);
        else await readConfirmationText(page);
        result.confirmation = {
          confirmed: Boolean(action.expectText),
          expected: action.expectText ? "[redacted]" : null,
          text: "[redacted]",
        };
      }
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
    let focusedShotTarget: ActionTargetMetadata | undefined;
    if (action.kind === "shot" && action.ref) {
      const resolved = await resolveRef(page, action.ref, {
        pageName: request.page,
        timeoutMs: request.timeoutMs,
        scroll: true,
        applicability: "pointer",
        legacyRefs: protocolVersion === 1,
      });
      try {
        focusedShotTarget = actionTargetMetadata(resolved, "screenshot");
        result.targets = [focusedShotTarget];
      } finally {
        await resolved.cleanup();
      }
    }
    const visualPerception = await perceive(page, { full: request.fullPage }, false);
    const focusElement =
      action.kind === "shot" && action.ref
        ? visualPerception.elements.find((element) => element.ref === focusedShotTarget?.actualRef)
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
      timeoutMs: request.shotTimeoutMs ?? Math.min(request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, 8_000),
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

  const requestSecrets = [
    action.kind === "confirm" || action.kind === "click" ? action.expectText : undefined,
    action.kind === "paste" ? action.text : undefined,
    "confirmToken" in action ? action.confirmToken : undefined,
  ].filter((value): value is string => Boolean(value));
  requestSecrets.push(...sensitiveValues);
  return redactSensitive(result, {
    allowConfirmationToken: action.kind === "confirm" && protocolVersion === 2,
    secrets: requestSecrets,
  }) as InteractiveResult;
}
