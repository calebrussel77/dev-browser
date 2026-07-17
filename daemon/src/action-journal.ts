import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import type { AttemptChange, AttemptJournalEntry } from "./retry-policy.js";
import type { WaitEvents } from "./wait-engine.js";

export function attemptFrameContext(
  ref: string | null = null,
  target?: { frameId?: string; framePath?: string[]; shadowContext?: string[]; actualRef?: string }
): NonNullable<AttemptJournalEntry["frameContext"]> {
  const frameId = target?.frameId ?? (/^(F\d+):/.exec(ref ?? "")?.[1] ?? "F0");
  return {
    frameId: frameId.slice(0, 32),
    framePath: (target?.framePath ?? [frameId]).slice(0, 20).map((part) => part.slice(0, 32)),
    shadowContext: (target?.shadowContext ?? []).slice(0, 20).map((part) => part.slice(0, 100)),
    ref: (target?.actualRef ?? ref)?.slice(0, 32) ?? null,
  };
}

export function recordAttempt(
  journal: AttemptJournalEntry[],
  entry: Omit<AttemptJournalEntry, "frameContext"> & { frameContext?: AttemptJournalEntry["frameContext"] },
  context?: AttemptJournalEntry["frameContext"]
): void {
  journal.push({ ...entry, frameContext: entry.frameContext ?? context ?? attemptFrameContext() });
}

export function originatingAttemptFrameContext(
  journal: AttemptJournalEntry[]
): AttemptJournalEntry["frameContext"] {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index]!;
    if (entry.inputMethod !== "download" && entry.inputMethod !== "popup" && entry.frameContext)
      return entry.frameContext;
  }
  return attemptFrameContext();
}

export function emptyWaitEvents(): WaitEvents {
  return { requests: [], mutations: [], focusChanges: [], valueChanges: [], dialogs: [], popup: [], download: [], fileChooser: [], navigation: [], responses: [], failedRequests: [] };
}

export function unchangedAttempt(): AttemptChange {
  return { any: false, url: false, snapshot: false, dialog: false, ariaExpanded: false, dom: false, focus: false, value: false };
}

export function boundedWaitEvents(events: WaitEvents): WaitEvents {
  return Object.fromEntries(Object.entries(events).map(([key, entries]) => [key, entries.slice(0, 2)])) as unknown as WaitEvents;
}

export function mergeWaitEvents(left: WaitEvents, right: WaitEvents): WaitEvents {
  return Object.fromEntries(Object.keys(left).map((key) => {
    const name = key as keyof WaitEvents;
    return [name, [...left[name], ...right[name]].slice(0, 2)];
  })) as unknown as WaitEvents;
}

export function trustedInputError(error: unknown, page: Page): AgentProtocolError {
  if (error instanceof AgentProtocolError) return error;
  if (page.isClosed()) return new AgentProtocolError("PAGE_CLOSED", "Page closed during trusted input", true);
  const message = error instanceof Error ? error.message : String(error);
  if (/frame.*(?:detached|navigat)|execution context was destroyed/i.test(message))
    return new AgentProtocolError("FRAME_DETACHED", "Frame detached or navigated during trusted input", true);
  return new AgentProtocolError("RENDERER_UNRESPONSIVE", (message || "Trusted input failed").slice(0, 500), false);
}

export function attemptErrorReason(error: AgentProtocolError): string {
  if (error.code === "LEASE_CONFLICT") return "lease-conflict";
  if (error.code === "STALE_REF" || error.code === "STALE_STATE") return "state-revalidation-failed";
  if (error.code === "PAGE_CLOSED") return "page-closed";
  if (error.code === "FRAME_DETACHED") return "frame-detached";
  if (error.code === "TARGET_DISABLED" || error.code === "TARGET_HIDDEN" || error.code === "TARGET_MISSING" || error.code === "TARGET_OBSCURED") return "target-not-actionable";
  return "trusted-input-error";
}

export function withAttemptJournal(error: AgentProtocolError, journal: AttemptJournalEntry[]): AgentProtocolError {
  for (const entry of journal) entry.frameContext ??= attemptFrameContext();
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
  const { events: _events, ...safeDetails } = details;
  const journalDetails = { attempts: journal.length, attemptJournal: journal.slice(0, 50) };
  try {
    return new AgentProtocolError(error.code, error.message, error.recoverable, { details: { ...safeDetails, ...journalDetails }, nextCommands: error.nextCommands });
  } catch {
    return new AgentProtocolError(error.code, error.message, error.recoverable, { details: journalDetails, nextCommands: error.nextCommands });
  }
}
