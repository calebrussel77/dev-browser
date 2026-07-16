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

interface Snapshot {
  url: string;
  title: string;
  focusedRef: string | null;
  elements: Map<string, string>;
}

interface PageHistory {
  realmToken: string;
  documentNumber: number;
  stateNumber: number;
  tracks: Map<string, Snapshot>;
}

const histories = new WeakMap<Page, PageHistory>();
let nextDocumentNumber = 1;

function fingerprint(element: PerceptionElement): string {
  return JSON.stringify({
    name: element.name,
    description: element.description,
    box: element.box,
    visible: element.visible,
    inViewport: element.inViewport,
    obscured: element.obscured,
    disabled: element.disabled,
    readonly: element.readonly,
    required: element.required,
    checked: element.checked,
    selected: element.selected,
    expanded: element.expanded,
    pressed: element.pressed,
    current: element.current,
    value: element.value,
    focused: element.focused,
  });
}

export function recordPageState(
  page: Page,
  realmToken: string,
  track: string,
  current: Omit<Snapshot, "elements"> & { elements: PerceptionElement[] },
  includeDelta: boolean
): { documentId: string; stateId: string; delta: PerceptionDelta | null } {
  let history = histories.get(page);
  if (!history || history.realmToken !== realmToken) {
    history = {
      realmToken,
      documentNumber: nextDocumentNumber++,
      stateNumber: 0,
      tracks: new Map(),
    };
    histories.set(page, history);
  }

  history.stateNumber += 1;
  const elements = new Map(current.elements.map((element) => [element.ref, fingerprint(element)]));
  const previous = history.tracks.get(track);
  const next: Snapshot = { ...current, elements };
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
  return { documentId, stateId: `${documentId}:${history.stateNumber}`, delta };
}
