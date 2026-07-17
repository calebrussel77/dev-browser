export interface RealmContentScope {
  ref?: string;
  within?: string;
}

export interface RealmScopeResult {
  requested: boolean;
  matched: boolean;
  ambiguous: boolean;
  count: number;
}

export interface RealmTextResult {
  text: string;
  truncated: boolean;
}

export interface RealmCollectionOptions {
  full: boolean;
  legacyRefs: boolean;
  maxRecords?: number;
  maxWork?: number;
  scope?: RealmContentScope;
  textOnly?: boolean;
  textMaxChars?: number;
}

export function collectRealm({
  full,
  legacyRefs,
  maxRecords = 2_000,
  maxWork = 5_000,
  scope,
  textOnly = false,
  textMaxChars = 20_000,
}: RealmCollectionOptions) {
  type BoundedText = (root: Node, maxChars?: number, maxNodes?: number) => { text: string; truncated: boolean; visited: number };
  type RealmState = { token: string; refs: WeakMap<Element, string>; byRef: Map<string, WeakRef<Element>>; boundedText?: BoundedText; counter: number };
  type RealmWindow = Window & { __devBrowserPerceptionState?: RealmState };
  const realmWindow = window as RealmWindow;
  if (!realmWindow.__devBrowserPerceptionState) {
    Object.defineProperty(realmWindow, "__devBrowserPerceptionState", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: { token: `${Date.now()}-${Math.random()}`, refs: new WeakMap<Element, string>(), byRef: new Map<string, WeakRef<Element>>(), counter: 1 },
    });
  }
  const registry = realmWindow.__devBrowserPerceptionState!;
  registry.byRef ??= new Map<string, WeakRef<Element>>();
  registry.boundedText ??= (root, maxChars = 2_000, maxNodes = 500) => {
    const stack: Node[] = [root];
    let text = "", visited = 0, truncated = false;
    while (stack.length > 0 && visited < maxNodes && text.length < maxChars) {
      const current = stack.pop()!;
      visited += 1;
      if (current.nodeType === Node.TEXT_NODE) {
        const data = (current as Text).data;
        const remaining = maxChars - text.length;
        text += data.slice(0, remaining);
        if (data.length > remaining) truncated = true;
        continue;
      }
      const children = current.childNodes;
      const remainingNodes = Math.max(0, maxNodes - visited - stack.length);
      const selected = Math.min(children.length, remainingNodes);
      if (children.length > selected) truncated = true;
      for (let index = selected - 1; index >= 0; index -= 1) stack.push(children.item(index)!);
    }
    if (stack.length > 0) truncated = true;
    return { text: text.replace(/\s+/g, " ").trim(), truncated, visited };
  };
  const boundedDescendantText = registry.boundedText;
  const actionableSelector =
    "a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex]:not([tabindex='-1'])";
  const includeSelector = `${actionableSelector},h1,h2,h3,h4,h5,h6,main,nav,aside,header,footer,section,article,p,label,output`;
  const compact = (value: string | null | undefined, max = 180) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const descriptor = (element: Element) => {
    const html = element as HTMLElement;
    return `${element.tagName.toLowerCase()}${html.id ? `#${compact(html.id, 50)}` : ""}${html.dataset.testid ? `[data-testid=${compact(html.dataset.testid, 50)}]` : ""}`;
  };
  // Scope resolution semantics MUST stay identical to resolveScopedText in
  // daemon/src/scoped-content.ts and to landmarkScopeMatches in
  // daemon/src/targeting.ts (find's within grammar as the base, plus the
  // role:/name: extensions); DOM tests in scoped-content.test.ts cross-check.
  const normalizeMatch = (value: string): string =>
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const accessibleScopeName = (element: Element): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return compact(aria);
    return boundedDescendantText(element, 500, 100).text;
  };
  const scopeDescriptorFor = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${compact(element.id, 50)}` : "";
    const role = element.getAttribute("role");
    return `${tag}${id}${role ? `[role=${role}]` : ""}`;
  };
  const scopeContainerSelector =
    "main,aside,nav,header,footer,section,article,dialog,[role],[aria-label]";
  let scopeRoot: Element = document.documentElement ?? document.body;
  const scopeResult: RealmScopeResult = { requested: false, matched: true, ambiguous: false, count: 1 };
  if (scope && (scope.ref || scope.within)) {
    scopeResult.requested = true;
    let scopeMatches: Element[] = [];
    if (scope.ref) {
      const found = registry.byRef.get(scope.ref)?.deref();
      scopeMatches = found && found.isConnected ? [found] : [];
    } else if (scope.within) {
      const value = scope.within;
      const roleMatch = /^role:(.+)$/.exec(value);
      const nameMatch = /^name:(.+)$/.exec(value);
      if (roleMatch)
        scopeMatches = Array.from(
          document.querySelectorAll(`[role="${roleMatch[1]!.replace(/"/g, '\\"')}"]`)
        );
      else if (nameMatch) {
        const target = nameMatch[1]!.trim().toLowerCase();
        scopeMatches = Array.from(document.querySelectorAll(scopeContainerSelector))
          .filter((element) => accessibleScopeName(element).toLowerCase() === target);
      } else {
        const needle = normalizeMatch(value);
        const matched = needle
          ? Array.from(document.querySelectorAll(scopeContainerSelector)).filter((element) =>
              normalizeMatch(scopeDescriptorFor(element)).includes(needle)
            )
          : [];
        scopeMatches = matched.filter(
          (element) => !matched.some((other) => other !== element && other.contains(element))
        );
      }
    }
    scopeResult.count = scopeMatches.length;
    scopeResult.matched = scopeMatches.length === 1;
    scopeResult.ambiguous = scopeMatches.length > 1;
    if (scopeResult.matched) scopeRoot = scopeMatches[0]!;
  }
  const textResult: RealmTextResult | undefined =
    textOnly && scopeResult.matched
      ? (() => {
          const raw = (scopeRoot as HTMLElement).innerText ?? scopeRoot.textContent ?? "";
          const normalized = raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
          const truncated = normalized.length > textMaxChars;
          return { text: truncated ? normalized.slice(0, textMaxChars) : normalized, truncated };
        })()
      : undefined;
  const candidates: Array<{ element: HTMLElement; shadowContext: string[]; depth: number }> = [];
  const allElements: HTMLElement[] = [];
  type Pending = { element: HTMLElement; shadowContext: string[]; depth: number };
  const pending: Pending[] = [];
  let traversalTruncated = false;
  const pushChildrenReverse = (children: HTMLCollection, shadowContext: string[], depth: number) => {
    const remaining = Math.max(0, maxWork - allElements.length - pending.length);
    const selected = Math.min(children.length, remaining);
    if (children.length > selected) traversalTruncated = true;
    for (let index = selected - 1; index >= 0; index -= 1)
      pending.push({ element: children.item(index) as HTMLElement, shadowContext, depth });
  };
  if (!scopeResult.requested || scopeResult.matched) pushChildrenReverse(scopeRoot.children, [], 0);
  while (pending.length > 0 && allElements.length < maxWork) {
    const current = pending.pop()!;
    const { element, shadowContext, depth } = current;
    allElements.push(element);
    if (element.matches(includeSelector)) candidates.push(current);
    if (depth >= 100) {
      if (element.children.length > 0 || element.shadowRoot?.children.length) traversalTruncated = true;
      continue;
    }
    const remaining = Math.max(0, maxWork - allElements.length - pending.length);
    const lightCount = Math.min(element.children.length, remaining);
    const shadowChildren = element.shadowRoot?.children;
    const shadowCount = Math.min(shadowChildren?.length ?? 0, remaining - lightCount);
    if (lightCount < element.children.length || shadowCount < (shadowChildren?.length ?? 0)) traversalTruncated = true;
    for (let index = shadowCount - 1; index >= 0; index -= 1)
      pending.push({ element: shadowChildren!.item(index) as HTMLElement, shadowContext: [...shadowContext, descriptor(element)].slice(0, 20), depth: depth + 1 });
    for (let index = lightCount - 1; index >= 0; index -= 1)
      pending.push({ element: element.children.item(index) as HTMLElement, shadowContext, depth: depth + 1 });
  }
  if (pending.length > 0) traversalTruncated = true;
  const roleFor = (element: HTMLElement): string => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return tag;
  };
  const referencedText = (attribute: string, element: HTMLElement) => {
    const root = element.getRootNode() as Document | ShadowRoot;
    return compact((element.getAttribute(attribute) ?? "").split(/\s+/)
      .map((id) => { const target = root.getElementById(id); return target ? boundedDescendantText(target, 500, 100).text : ""; }).join(" "));
  };
  const labelFor = (element: HTMLElement) =>
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? compact(Array.from(element.labels ?? [], (label) => boundedDescendantText(label, 500, 100).text).join(" ")) : "";
  const nameFor = (element: HTMLElement) => compact(
    element.getAttribute("aria-label") || referencedText("aria-labelledby", element) || labelFor(element) ||
    boundedDescendantText(element, 500, 100).text || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder")
  );
  const bool = (element: HTMLElement, name: string): boolean | null => {
    const value = element.getAttribute(name); return value === null ? null : value === "true";
  };
  const mixedBool = (element: HTMLElement, name: string): boolean | "mixed" | null => {
    const value = element.getAttribute(name); return value === "mixed" ? "mixed" : value === null ? null : value === "true";
  };
  const ancestors = (element: HTMLElement) => {
    const values: string[] = [];
    let parent: HTMLElement | null = element.parentElement;
    while (parent && parent !== document.body) {
      const tag = parent.tagName.toLowerCase(), role = parent.getAttribute("role");
      if (["main", "aside", "nav", "header", "footer", "section", "article", "dialog"].includes(tag) || role)
        values.unshift(`${tag}${parent.id ? `#${compact(parent.id, 50)}` : ""}${role ? `[role=${role}]` : ""}`);
      parent = parent.parentElement;
    }
    return values;
  };
  const usedRefs = new Set(legacyRefs ? allElements.map((element) => element.getAttribute("data-dev-browser-ref") ?? "").filter((ref) => /^R\d+$/.test(ref)) : []);
  const deepActive = () => {
    let active: Element | null = document.activeElement;
    while (active instanceof HTMLElement && active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  const active = deepActive();
  const records = candidates.slice(0, maxRecords).map(({ element, shadowContext, depth }) => {
    const actionable = element.matches(actionableSelector);
    const legacyRef = element.getAttribute("data-dev-browser-ref") ?? "";
    let ref = actionable ? (registry.refs.get(element) ?? (legacyRefs && /^R\d+$/.test(legacyRef) ? legacyRef : "")) : "";
    if (actionable && !ref) {
      do ref = `R${registry.counter++}`; while (usedRefs.has(ref));
      registry.refs.set(element, ref); usedRefs.add(ref);
    } else if (actionable && ref) registry.refs.set(element, ref);
    if (actionable && ref) registry.byRef.set(ref, new WeakRef(element));
    if (actionable && legacyRefs && !element.hasAttribute("data-dev-browser-ref")) element.setAttribute("data-dev-browser-ref", ref);
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0;
    const inViewport = visible && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    const centerX = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const centerY = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const root = element.getRootNode();
    const hit = inViewport ? (root instanceof ShadowRoot ? root.elementFromPoint(centerX, centerY) : document.elementFromPoint(centerX, centerY)) : null;
    const obscured = Boolean(actionable && inViewport && hit && hit !== element && !element.contains(hit) && !hit.contains(element));
    const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null;
    const rawValue = element instanceof HTMLInputElement && ["password", "hidden"].includes(element.type) ? (element.value ? "[redacted]" : "")
      : element instanceof HTMLInputElement && element.type === "file" ? (element.files?.length ? "[file selected]" : "")
      : input ? input.value : element.isContentEditable ? boundedDescendantText(element, 500, 100).text : "";
    const checked = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
      ? element.indeterminate ? "mixed" : element.checked : mixedBool(element, "aria-checked");
    const heading = element.closest("section,article,main,aside")?.querySelector("h1,h2,h3,h4,h5,h6");
    const semanticAncestors = ancestors(element);
    return {
      ref, role: roleFor(element), name: nameFor(element),
      description: compact(element.getAttribute("aria-description") || referencedText("aria-describedby", element)),
      landmark: semanticAncestors.join(" > ") || "body", semanticAncestors,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible, inViewport, actionable, obscured,
      disabled: "disabled" in element ? Boolean((element as HTMLInputElement).disabled) : bool(element, "aria-disabled") === true,
      readonly: "readOnly" in element ? Boolean((element as HTMLInputElement).readOnly) : bool(element, "aria-readonly") === true,
      required: "required" in element ? Boolean((element as HTMLInputElement).required) : bool(element, "aria-required") === true,
      checked, selected: element instanceof HTMLOptionElement ? element.selected : bool(element, "aria-selected"),
      expanded: bool(element, "aria-expanded"), pressed: mixedBool(element, "aria-pressed"),
      current: element.hasAttribute("aria-current") ? element.getAttribute("aria-current") || true : null,
      ...(full ? { value: compact(rawValue, 500) } : {}), placeholder: compact(element.getAttribute("placeholder")),
      inputType: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
      stableAttributes: { id: compact(element.id, 100), testId: compact(element.getAttribute("data-testid"), 100), href: element instanceof HTMLAnchorElement ? compact(element.getAttribute("href"), 300) : "" },
      focused: active === element,
      nearby: { heading: heading ? boundedDescendantText(heading, 500, 100).text : "", label: labelFor(element), context: full && element.parentElement ? boundedDescendantText(element.parentElement, 500, 100).text : "" },
      shadowContext, depth,
    };
  });
  return { realmToken: registry.token, url: location.href, title: document.title,
    viewport: { width: innerWidth, height: innerHeight }, focusedRef: records.find((record) => record.focused)?.ref || null,
    records, truncated: traversalTruncated || candidates.length > maxRecords || allElements.length >= maxWork,
    scope: scopeResult, text: textResult };
}
