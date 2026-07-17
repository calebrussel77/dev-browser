import type { WaitEvents } from "./wait-engine.js";

export type RetryPolicy = "never" | "safe" | "once";

export interface AttemptChange {
  any: boolean;
  url: boolean;
  snapshot: boolean;
  dialog: boolean;
  ariaExpanded: boolean;
  dom: boolean;
  focus: boolean;
  value: boolean;
  coverageTruncated?: boolean;
}

export interface AttemptJournalEntry {
  attempt: number;
  startedAt: string;
  inputMethod: "mouse" | "locator" | "focus" | "keyboard" | "wheel" | "select" | "check" | "uncheck" | "hover" | "drag" | "navigation" | "upload" | "download" | "popup";
  sideEffects: WaitEvents;
  change: AttemptChange;
  retryDecision: "retry" | "stop";
  reason: string;
  frameContext?: { frameId: string; framePath: string[]; shadowContext: string[]; ref: string | null };
}

export function hasSideEffects(events: WaitEvents): boolean {
  return (
    events.requests.length > 0 ||
    events.mutations.length > 0 ||
    events.focusChanges.length > 0 ||
    events.valueChanges.length > 0 ||
    events.dialogs.length > 0 ||
    events.responses.length > 0 ||
    events.failedRequests.length > 0 ||
    events.navigation.length > 0 ||
    events.popup.length > 0 ||
    events.download.length > 0 ||
    events.fileChooser.length > 0
  );
}

export function retryDecision(input: {
  policy: RetryPolicy;
  attempt: number;
  guarded: boolean;
  irreversibleIntent: boolean;
  sideEffects: WaitEvents;
  change: AttemptChange;
}): { retryDecision: "retry" | "stop"; reason: string } {
  if (input.attempt >= 2) return { retryDecision: "stop", reason: "retry-limit-reached" };
  if (input.change.coverageTruncated)
    return { retryDecision: "stop", reason: "observation-coverage-truncated" };
  if (input.policy === "never") return { retryDecision: "stop", reason: "retry-policy-never" };
  if (input.guarded) return { retryDecision: "stop", reason: "guarded-expect-text" };
  if (input.policy === "once" && input.irreversibleIntent)
    return { retryDecision: "stop", reason: "irreversible-intent-blocked" };
  if (input.policy === "safe" && input.sideEffects.valueChanges.length > 0)
    return { retryDecision: "stop", reason: "value-side-effect" };
  if (input.policy === "safe" && (hasSideEffects(input.sideEffects) || input.change.any))
    return { retryDecision: "stop", reason: "safe-retry-side-effect-or-change" };
  return {
    retryDecision: "retry",
    reason: input.policy === "safe" ? "safe-no-side-effect" : "explicit-once",
  };
}
