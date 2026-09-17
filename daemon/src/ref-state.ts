import type { Page } from "playwright";

import { AgentProtocolError } from "./agent-protocol.js";
import { parseScopedRef, registeredFrame } from "./frame-registry.js";
import {
  getPageStateIdentity,
  getRecordedState,
  recordedStatesEqual,
  semanticFingerprint,
} from "./page-state.js";
import type { PagePerception } from "./perception/collector.js";
import { revalidateRealmRef } from "./perception/realm-collector.js";
import { observeRecoveryCommand } from "./recovery-command.js";

export interface StateGuard { fromState?: string; strictState?: boolean }

interface FingerprintShape {
  frameId: string;
  framePath?: string[];
  frameDocumentId?: string;
  shadowContext: string[];
  [key: string]: unknown;
}

export async function revalidateRef(
  page: Page,
  ref: string,
  expectedFingerprint: string
): Promise<{ attached: boolean; fingerprint?: string; mutationEpoch: number; realmToken: string }> {
  const scoped = parseScopedRef(ref);
  if (!scoped) return { attached: false, mutationEpoch: 0, realmToken: "" };
  const expected = JSON.parse(expectedFingerprint) as FingerprintShape;
  const frameEntry =
    scoped.frameId === "F0"
      ? {
          frame: page.mainFrame(),
          id: "F0",
          path: ["F0"],
          realmToken: expected.frameDocumentId ?? "",
        }
      : registeredFrame(page, scoped.frameId);
  if (!frameEntry) return { attached: false, mutationEpoch: 0, realmToken: "" };
  const current = await frameEntry.frame
    .evaluate(revalidateRealmRef, scoped.localRef)
    .catch(() => null);
  if (!current?.attached || !current.fingerprint)
    return { attached: false, mutationEpoch: current?.mutationEpoch ?? 0, realmToken: current?.realmToken ?? "" };
  if (
    expected.frameDocumentId &&
    current.realmToken.slice(0, 100) !== expected.frameDocumentId
  ) return { attached: false, mutationEpoch: current.mutationEpoch, realmToken: current.realmToken };
  const { shadowContext, ...semantic } = current.fingerprint;
  return {
    attached: true,
    mutationEpoch: current.mutationEpoch,
    realmToken: current.realmToken,
    fingerprint: JSON.stringify({
      ...semantic,
      frameId: frameEntry.id,
      framePath: frameEntry.path,
      frameDocumentId: current.realmToken.slice(0, 100),
      shadowContext,
    }),
  };
}

export async function validateObservedDecisionTargeted(
  page: Page,
  pageName: string,
  guard: StateGuard,
  refs: Array<string | undefined>,
  previousLatestStateId: string | null,
  includeUnversionedWarning = false
): Promise<string[]> {
  const warnings: string[] = [];
  const identity = getPageStateIdentity(page);
  const fromState = guard.fromState;
  const sourceState = fromState
    ? getRecordedState(page, fromState)
    : previousLatestStateId
      ? getRecordedState(page, previousLatestStateId)
      : undefined;
  const checkedRefs = await Promise.all(
    refs.flatMap((ref) => {
      if (!ref) return [];
      const expected = sourceState?.elements.get(ref);
      return [{
        ref,
        expected,
        current: expected ? revalidateRef(page, ref, expected) : Promise.resolve(undefined),
      }];
    }).map(async (entry) => ({ ...entry, current: await entry.current }))
  );
  const mainValidation = checkedRefs.find((entry) => parseScopedRef(entry.ref)?.frameId === "F0")?.current;
  const currentRealm = mainValidation
    ? { token: mainValidation.realmToken, mutationEpoch: mainValidation.mutationEpoch }
    : await page.mainFrame().evaluate(() => {
        const state = (window as Window & {
          __devBrowserPerceptionState?: { token: string; mutationEpoch?: number };
        }).__devBrowserPerceptionState;
        return {
          token: state?.token ?? "",
          mutationEpoch: state?.mutationEpoch ?? 0,
        };
      });
  const latestDetails = {
    documentId: identity?.documentId ?? "unknown",
    stateId: identity?.latestStateId ?? "unknown",
    url: page.url(),
    title: sourceState?.title ?? "",
  };
  const throwStale = (code: "STALE_REF" | "STALE_STATE", message: string): never => {
    throw new AgentProtocolError(code, message, true, {
      details: { latest: latestDetails },
      nextCommands: [observeRecoveryCommand(pageName)],
    });
  };
  if (fromState) {
    const observed = getRecordedState(page, fromState);
    if (
      !observed ||
      !identity ||
      identity.realmToken !== currentRealm.token ||
      !fromState.startsWith(`${identity.documentId}:`)
    ) throwStale("STALE_STATE", `State ${fromState} belongs to an expired document`);
    if (
      guard.strictState &&
      (previousLatestStateId !== fromState || observed!.mutationEpoch !== currentRealm.mutationEpoch)
    ) throwStale("STALE_STATE", `State ${fromState} is no longer current`);
  } else if (includeUnversionedWarning || guard.strictState) {
    warnings.push("Unversioned decision: document and target identity were validated without --from-state");
  }

  for (const { ref, expected, current } of checkedRefs) {
    if (!expected || !current?.attached || current.fingerprint !== expected)
      throwStale("STALE_REF", `Element ref "${ref}" is stale or semantically changed`);
  }
  return warnings;
}

function stale(pageName: string, code: "STALE_REF" | "STALE_STATE", message: string, latest: PagePerception): never {
  throw new AgentProtocolError(code, message, true, {
    details: {
      latest: { documentId: latest.documentId, stateId: latest.stateId, url: latest.url, title: latest.title },
    },
    nextCommands: [observeRecoveryCommand(pageName)],
  });
}

export function validateObservedDecision(
  page: Page,
  pageName: string,
  guard: StateGuard,
  ref: string | undefined,
  latest: PagePerception,
  previousLatestStateId: string | null,
  includeUnversionedWarning = false
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
  } else if (includeUnversionedWarning || guard.strictState) {
    warnings.push("Unversioned decision: document and target identity were validated without --from-state");
  }

  if (ref) {
    const sourceState = fromState ? getRecordedState(page, fromState) : previousLatestStateId ? getRecordedState(page, previousLatestStateId) : undefined;
    const expected = sourceState?.elements.get(ref);
    // Look the current fingerprint up in the recorded snapshot (all collected
    // records) rather than latest.elements, which is capped at the display
    // maxNodes budget and would read refs beyond it as stale.
    const currentElement = latest.elements.find((element) => element.ref === ref);
    const current = currentElement
      ? semanticFingerprint(currentElement)
      : getRecordedState(page, latest.stateId)?.elements.get(ref);
    if (!expected || !current || current !== expected) {
      stale(pageName, "STALE_REF", `Element ref "${ref}" is stale or semantically changed`, latest);
    }
  }
  return warnings;
}
