import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import type { AttemptChange, AttemptJournalEntry } from "./retry-policy.js";
import type { WaitEvents } from "./wait-engine.js";

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
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
  const { events: _events, ...safeDetails } = details;
  const journalDetails = { attempts: journal.length, attemptJournal: journal.slice(0, 50) };
  try {
    return new AgentProtocolError(error.code, error.message, error.recoverable, { details: { ...safeDetails, ...journalDetails }, nextCommands: error.nextCommands });
  } catch {
    return new AgentProtocolError(error.code, error.message, error.recoverable, { details: journalDetails, nextCommands: error.nextCommands });
  }
}
