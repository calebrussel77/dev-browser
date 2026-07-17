import type { Frame, Page } from "playwright";

export interface RegisteredFrame {
  id: string;
  frame: Frame;
  realmToken: string;
  path: string[];
  url: string;
  name: string;
}

interface FrameRegistryState {
  topRealmToken: string;
  frames: Map<string, RegisteredFrame>;
}

const registries = new WeakMap<Page, FrameRegistryState>();
const identities = new WeakMap<Page, { ids: WeakMap<Frame, string>; next: number }>();

export function beginFrameGeneration(page: Page, topRealmToken: string): void {
  const registry = registries.get(page);
  if (registry && registry.topRealmToken === topRealmToken) return;
  identities.set(page, { ids: new WeakMap(), next: 1 });
}

export function stableFrameId(page: Page, frame: Frame): string {
  if (frame === page.mainFrame()) return "F0";
  let state = identities.get(page);
  if (!state) {
    state = { ids: new WeakMap(), next: 1 };
    identities.set(page, state);
  }
  const existing = state.ids.get(frame);
  if (existing) return existing;
  const id = `F${state.next++}`;
  state.ids.set(frame, id);
  return id;
}

export function registerFrames(
  page: Page,
  topRealmToken: string,
  frames: RegisteredFrame[]
): void {
  registries.set(page, {
    topRealmToken,
    frames: new Map(frames.map((entry) => [entry.id, entry])),
  });
}

export function registeredFrame(page: Page, id: string): RegisteredFrame | undefined {
  return registries.get(page)?.frames.get(id);
}

export function registeredFrames(page: Page): RegisteredFrame[] {
  return [...(registries.get(page)?.frames.values() ?? [])];
}

export function parseScopedRef(ref: string): { frameId: string; localRef: string } | null {
  const match = /^(?:(F\d+):)?(R\d+)$/.exec(ref);
  return match ? { frameId: match[1] ?? "F0", localRef: match[2]! } : null;
}
