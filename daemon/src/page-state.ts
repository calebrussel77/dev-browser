import type { Page } from "playwright";

import type { PerceptionElement } from "./perception/collector.js";

export interface PerceptionDelta {
  url?: { before: string; after: string };
  title?: { before: string; after: string };
  focus?: { before: string | null; after: string | null };
  added: string[];
  removed: string[];
  changed: string[];
}

export interface Snapshot {
  url: string;
  title: string;
  focusedRef: string | null;
  elements: Map<string, string>;
  signature: string;
  // The content scope the producing collection ran under, when any. Action-time
  // ref revalidation replays the same scope so refs from a scoped observe are
  // resolved against the same bounded collection that produced them.
  scope?: { ref?: string; within?: string };
}

interface PageHistory {
  realmToken: string;
  documentNumber: number;
  stateNumber: number;
  tracks: Map<string, Snapshot>;
  states: Map<string, Snapshot>;
  latestStateId: string | null;
}

const histories = new WeakMap<Page, PageHistory>();
let nextDocumentNumber = 1;

export function semanticFingerprint(element: PerceptionElement): string {
  return JSON.stringify({
    role: element.role,
    name: element.name,
    description: element.description,
    landmark: element.landmark,
    placeholder: element.placeholder,
    inputType: element.inputType,
    stableAttributes: element.stableAttributes,
    disabled: element.disabled,
    readonly: element.readonly,
    required: element.required,
    checked: element.checked,
    selected: element.selected,
    expanded: element.expanded,
    pressed: element.pressed,
    current: element.current,
    frameId: element.frameId,
    framePath: element.framePath,
    frameDocumentId: element.frameDocumentId,
    shadowContext: element.shadowContext,
  });
}

export function getRecordedState(page: Page, stateId: string): Snapshot | undefined {
  return histories.get(page)?.states.get(stateId);
}

export function getLatestStateId(page: Page): string | null {
  return histories.get(page)?.latestStateId ?? null;
}

export function recordedStatesEqual(page: Page, left: string, right: string): boolean {
  const history = histories.get(page);
  const a = history?.states.get(left);
  const b = history?.states.get(right);
  return Boolean(a && b && a.signature === b.signature);
}

export function discardValidationState(
  page: Page,
  validationStateId: string,
  restoreStateId: string | null
): void {
  const history = histories.get(page);
  if (!history || history.latestStateId !== validationStateId) return;
  history.states.delete(validationStateId);
  history.latestStateId = restoreStateId;
}

export function recordPageState(
  page: Page,
  realmToken: string,
  track: string,
  current: Omit<Snapshot, "elements" | "signature"> & { elements: PerceptionElement[] },
  includeDelta: boolean
): { documentId: string; stateId: string; delta: PerceptionDelta | null } {
  let history = histories.get(page);
  if (!history || history.realmToken !== realmToken) {
    history = {
      realmToken,
      documentNumber: nextDocumentNumber++,
      stateNumber: 0,
      tracks: new Map(),
      states: new Map(),
      latestStateId: null,
    };
    histories.set(page, history);
  }

  history.stateNumber += 1;
  const elements = new Map(
    current.elements.filter((element) => element.ref).map((element) => [element.ref, semanticFingerprint(element)])
  );
  const previous = history.tracks.get(track);
  const signature = JSON.stringify({
    url: current.url,
    title: current.title,
    focusedRef: current.focusedRef,
    elements: current.elements.map(semanticFingerprint),
  });
  const next: Snapshot = { ...current, elements, signature };
  history.tracks.set(track, next);

  let delta: PerceptionDelta | null = null;
  if (includeDelta && previous) {
    delta = {
      ...(previous.url === current.url
        ? {}
        : { url: { before: previous.url, after: current.url } }),
      ...(previous.title === current.title
        ? {}
        : { title: { before: previous.title, after: current.title } }),
      ...(previous.focusedRef === current.focusedRef
        ? {}
        : { focus: { before: previous.focusedRef, after: current.focusedRef } }),
      added: [...elements.keys()].filter((ref) => !previous.elements.has(ref)),
      removed: [...previous.elements.keys()].filter((ref) => !elements.has(ref)),
      changed: [...elements.entries()]
        .filter(
          ([ref, value]) => previous.elements.has(ref) && previous.elements.get(ref) !== value
        )
        .map(([ref]) => ref),
    };
  }

  const documentId = `doc-${history.documentNumber}`;
  const stateId = `${documentId}:${history.stateNumber}`;
  history.states.set(stateId, next);
  history.latestStateId = stateId;
  while (history.states.size > 100) history.states.delete(history.states.keys().next().value!);
  return { documentId, stateId, delta };
}
