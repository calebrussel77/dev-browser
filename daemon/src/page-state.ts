import type { Page } from "playwright";

import type { PerceptionElement } from "./perception/collector.js";

export interface PerceptionDelta {
  url?: { before: string; after: string };
  title?: { before: string; after: string };
  focus?: { before: string | null; after: string | null };
  added: string[];
  removed: string[];
  changed: string[];
  summary: string;
  truncated?: true;
}

export interface Snapshot {
  url: string;
  title: string;
  focusedRef: string | null;
  elements: Map<string, string>;
  dialogs: Set<string>;
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
const MAX_DELTA_REFS = 50;

function deltaSummary(options: {
  added: number;
  removed: number;
  changed: number;
  urlChanged: boolean;
  titleChanged: boolean;
  focusChanged: boolean;
  dialogOpened: boolean;
  dialogClosed: boolean;
}): string {
  const parts: string[] = [];
  const refs = [
    options.added > 0 ? `+${options.added}` : "",
    options.removed > 0 ? `−${options.removed}` : "",
    options.changed > 0 ? `~${options.changed}` : "",
  ].filter(Boolean);
  if (refs.length > 0) parts.push(`${refs.join(" ")} refs`);
  if (options.urlChanged) parts.push("url changed");
  if (options.titleChanged) parts.push("title changed");
  if (options.focusChanged) parts.push("focus changed");
  if (options.dialogOpened) parts.push("dialog opened");
  if (options.dialogClosed) parts.push("dialog closed");
  return parts.join(", ") || "no observable changes";
}

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
  current: Omit<Snapshot, "elements" | "dialogs" | "signature"> & {
    elements: PerceptionElement[];
  },
  includeDelta: boolean
): { documentId: string; stateId: string; delta: PerceptionDelta | null } {
  let history = histories.get(page);
  if (!history || history.realmToken !== realmToken) {
    const tracks = history?.tracks ?? new Map<string, Snapshot>();
    history = {
      realmToken,
      documentNumber: nextDocumentNumber++,
      stateNumber: 0,
      tracks,
      states: new Map(),
      latestStateId: null,
    };
    histories.set(page, history);
  }

  history.stateNumber += 1;
  const fingerprinted = current.elements.map((element) => ({
    element,
    fingerprint: semanticFingerprint(element),
  }));
  const elements = new Map(
    fingerprinted
      .filter(({ element }) => element.ref)
      .map(({ element, fingerprint }) => [element.ref, fingerprint])
  );
  const dialogs = new Set(
    fingerprinted
      .filter(
        ({ element }) =>
          element.ref && (element.role === "dialog" || element.role === "alertdialog")
      )
      .map(({ element }) => element.ref)
  );
  const previous = history.tracks.get(track);
  const signature = JSON.stringify({
    url: current.url,
    title: current.title,
    focusedRef: current.focusedRef,
    elements: fingerprinted.map(({ fingerprint }) => fingerprint),
  });
  const next: Snapshot = { ...current, elements, dialogs, signature };
  history.tracks.set(track, next);

  let delta: PerceptionDelta | null = null;
  if (includeDelta && previous) {
    const added = [...elements.keys()].filter((ref) => !previous.elements.has(ref));
    const removed = [...previous.elements.keys()].filter((ref) => !elements.has(ref));
    const changed = [...elements.entries()]
      .filter(
        ([ref, value]) => previous.elements.has(ref) && previous.elements.get(ref) !== value
      )
      .map(([ref]) => ref);
    const urlChanged = previous.url !== current.url;
    const titleChanged = previous.title !== current.title;
    const focusChanged = previous.focusedRef !== current.focusedRef;
    const dialogOpened = [...dialogs].some((ref) => !previous.dialogs.has(ref));
    const dialogClosed = [...previous.dialogs].some((ref) => !dialogs.has(ref));
    const truncated = [added, removed, changed].some((refs) => refs.length > MAX_DELTA_REFS);
    delta = {
      ...(urlChanged
        ? { url: { before: previous.url, after: current.url } }
        : {}),
      ...(titleChanged
        ? { title: { before: previous.title, after: current.title } }
        : {}),
      ...(focusChanged
        ? { focus: { before: previous.focusedRef, after: current.focusedRef } }
        : {}),
      added: added.slice(0, MAX_DELTA_REFS),
      removed: removed.slice(0, MAX_DELTA_REFS),
      changed: changed.slice(0, MAX_DELTA_REFS),
      summary: deltaSummary({
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        urlChanged,
        titleChanged,
        focusChanged,
        dialogOpened,
        dialogClosed,
      }),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }

  const documentId = `doc-${history.documentNumber}`;
  const stateId = `${documentId}:${history.stateNumber}`;
  history.states.set(stateId, next);
  history.latestStateId = stateId;
  while (history.states.size > 100) history.states.delete(history.states.keys().next().value!);
  return { documentId, stateId, delta };
}
