import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { getRecordedState, recordedStatesEqual, semanticFingerprint } from "./page-state.js";
import type { PagePerception } from "./perception/collector.js";

export interface StateGuard { fromState?: string; strictState?: boolean }

function stale(pageName: string, code: "STALE_REF" | "STALE_STATE", message: string, latest: PagePerception): never {
  throw new AgentProtocolError(code, message, true, {
    details: {
      latest: { documentId: latest.documentId, stateId: latest.stateId, url: latest.url, title: latest.title },
    },
    nextCommands: [`dev-browser observe --page ${pageName} --delta`],
  });
}

export function validateObservedDecision(
  page: Page,
  pageName: string,
  guard: StateGuard,
  ref: string | undefined,
  latest: PagePerception,
  previousLatestStateId: string | null
): string[] {
  const warnings: string[] = [];
  const fromState = guard.fromState;
  if (fromState) {
    const observed = getRecordedState(page, fromState);
    if (!observed || !fromState.startsWith(`${latest.documentId}:`)) {
      stale(pageName, "STALE_STATE", `State ${fromState} belongs to an expired document`, latest);
    }
    if (
      guard.strictState &&
      (previousLatestStateId !== fromState || !recordedStatesEqual(page, fromState, latest.stateId))
    ) {
      stale(pageName, "STALE_STATE", `State ${fromState} is no longer current`, latest);
    }
  } else {
    warnings.push("Unversioned decision: document and target identity were validated without --from-state");
  }

  if (ref) {
    const sourceState = fromState ? getRecordedState(page, fromState) : previousLatestStateId ? getRecordedState(page, previousLatestStateId) : undefined;
    const expected = sourceState?.elements.get(ref);
    const current = latest.elements.find((element) => element.ref === ref);
    if (!expected || !current || semanticFingerprint(current) !== expected) {
      stale(pageName, "STALE_REF", `Element ref "${ref}" is stale or semantically changed`, latest);
    }
  }
  return warnings;
}
