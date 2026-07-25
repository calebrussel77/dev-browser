const REDACTED = "[redacted]";
const SENSITIVE_KEY = /^(?:cookie|set-cookie|authorization|proxy-authorization|password|passwd|secret|token|access_token|refresh_token|id_token|session|credential|expect(?:ed)?text|confirmationtoken)$/i;
const SENSITIVE_PARAM = /^(?:token|access_token|refresh_token|id_token|code|key|api_key|secret|password|signature|session|credential)$/i;
const FILE_CONTENT_KEY = /^(?:filecontents?|contents|buffer|requestbody)$/i;
const SENSITIVE_HEADER_NAME = /^(?:cookie|set-cookie|authorization|proxy-authorization)$/i;
const HEADER_CONTAINER_KEY = /headers?$/i;
const COOKIE_CONTAINER_KEY = /cookies?$/i;

export interface RedactionOptions {
  allowConfirmationToken?: boolean;
  /** Keeps a `path` value intact instead of masking the home directory, for
   * results whose whole point is the file the caller must open next. */
  allowOutputPath?: boolean;
  secrets?: string[];
}

const MAX_REDACTION_NODES = 20_000;
const MAX_SECRETS = 2_000;
const MAX_OBJECT_PROPERTIES = 2_000;
const CONTROL_KEY = /^(?:id|type|data|success|ok|error|code|message|recoverable|details|nextCommands|exitCode|schemaVersion|protocolVersion|requestId|browser|page|action|result|warnings?|confirmationToken)$/;
const CONTROL_STRING_VALUE_KEY = /^(?:type|code|schemaVersion|action)$/;

interface DiscoveryBudget {
  nodes: number;
  incomplete: boolean;
  values: WeakMap<object, Map<string, unknown>>;
}

function forEachOwnProperty(
  value: object,
  limit: number,
  visitor: (key: string) => void
): boolean {
  let scanned = 0;
  try {
    for (const key in value) {
      if (scanned >= limit) return false;
      scanned += 1;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      visitor(key);
    }
    return true;
  } catch {
    return false;
  }
}

function discoverProperty(value: object, key: string, budget: DiscoveryBudget): unknown {
  let child: unknown;
  try { child = (value as Record<string, unknown>)[key]; }
  catch {
    child = "[unavailable]";
    budget.incomplete = true;
  }
  let values = budget.values.get(value);
  if (!values) {
    values = new Map();
    budget.values.set(value, values);
  }
  values.set(key, child);
  return child;
}

function discoveredProperty(value: object, key: string, budget: DiscoveryBudget): unknown {
  const values = budget.values.get(value);
  if (!values?.has(key)) return "[unavailable]";
  return values.get(key);
}

function addSecret(secrets: Set<string>, value: string): void {
  if (value.length < 3 || secrets.size >= MAX_SECRETS) return;
  const add = (candidate: string) => {
    if (candidate.length >= 3 && secrets.size < MAX_SECRETS) secrets.add(candidate.slice(0, 8_000));
  };
  add(value);
  try { add(decodeURIComponent(value)); } catch { /* malformed input */ }
  try { add(decodeURIComponent(value.replace(/\+/g, "%20"))); } catch { /* malformed input */ }
  if (/%[0-9a-f]{2}/i.test(value)) {
    add(value.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase()));
    add(value.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toLowerCase()));
  }
}

function addCookieSecrets(secrets: Set<string>, value: string): void {
  addSecret(secrets, value);
  for (const part of value.split(/[;,]/)) {
    const separator = part.indexOf("=");
    if (separator >= 0) addSecret(secrets, part.slice(separator + 1).trim());
  }
}

function collectRawUrlSecrets(raw: string, secrets: Set<string>): void {
  for (const segment of raw.split(/[?#]/).slice(1)) {
    for (const pair of segment.split("&")) {
      const separator = pair.indexOf("=");
      if (separator < 0) continue;
      const rawKey = pair.slice(0, separator);
      const rawValue = pair.slice(separator + 1);
      let key = rawKey;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, "%20")); } catch { /* malformed input */ }
      if (SENSITIVE_PARAM.test(key)) addSecret(secrets, rawValue);
    }
  }
}

function redactUrl(raw: string, secrets: Set<string>): string {
  collectRawUrlSecrets(raw, secrets);
  try {
    const url = new URL(raw);
    if (url.username) { addSecret(secrets, url.username); url.username = REDACTED; }
    if (url.password) { addSecret(secrets, url.password); url.password = REDACTED; }
    const pairs = [...url.searchParams.entries()];
    url.search = "";
    for (const [key, value] of pairs) {
      if (SENSITIVE_PARAM.test(key)) { addSecret(secrets, value); url.searchParams.append(key, REDACTED); }
      else url.searchParams.append(key, value);
    }
    if (url.hash.length > 1) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      let changed = false;
      for (const [key, value] of [...fragment.entries()]) if (SENSITIVE_PARAM.test(key)) {
        addSecret(secrets, value); fragment.set(key, REDACTED); changed = true;
      }
      if (changed) url.hash = fragment.toString();
    }
    return url.toString();
  } catch { return raw; }
}

function collectSecrets(value: unknown, secrets: Set<string>, seen: WeakSet<object>, budget: DiscoveryBudget, depth = 0, key = ""): void {
  if (++budget.nodes > MAX_REDACTION_NODES || depth > 12 || secrets.size >= MAX_SECRETS) {
    budget.incomplete = true;
    return;
  }
  if (typeof value === "string") {
    const bounded = value.slice(0, 8_000);
    if (/^(?:cookie|set-cookie)$/i.test(key)) addCookieSecrets(secrets, bounded);
    else if (SENSITIVE_KEY.test(key) || FILE_CONTENT_KEY.test(key)) addSecret(secrets, bounded);
    for (const match of bounded.matchAll(/https?:\/\/[^\s"'<>]+/gi)) redactUrl(match[0], secrets);
    for (const match of bounded.matchAll(/\b(?:Bearer|Basic)\s+([^\s,;]+)/gi)) addSecret(secrets, match[1]!);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_OBJECT_PROPERTIES) budget.incomplete = true;
    for (let index = 0; index < Math.min(value.length, MAX_OBJECT_PROPERTIES); index += 1) {
      const child = discoverProperty(value, String(index), budget);
      collectSecrets(child, secrets, seen, budget, depth + 1, key);
    }
  } else {
    const children: Array<[string, unknown]> = [];
    const completed = forEachOwnProperty(value, MAX_OBJECT_PROPERTIES, (childKey) => {
      const child = discoverProperty(value, childKey, budget);
      children.push([childKey, child]);
    });
    if (!completed) budget.incomplete = true;
    const siblingName = children.find(([childKey]) => childKey.toLowerCase() === "name")?.[1];
    const siblingValue = children.find(([childKey]) => childKey.toLowerCase() === "value")?.[1];
    if (
      typeof siblingValue === "string" &&
      ((HEADER_CONTAINER_KEY.test(key) && typeof siblingName === "string" && SENSITIVE_HEADER_NAME.test(siblingName)) ||
        COOKIE_CONTAINER_KEY.test(key))
    ) {
      if (COOKIE_CONTAINER_KEY.test(key) || (typeof siblingName === "string" && /^(?:cookie|set-cookie)$/i.test(siblingName)))
        addCookieSecrets(secrets, siblingValue);
      else addSecret(secrets, siblingValue);
    }
    for (const [childKey, child] of children)
      collectSecrets(child, secrets, seen, budget, depth + 1, childKey);
  }
}

function safeString(
  value: string,
  secrets: Set<string>,
  conservative = false,
  keepHomePaths = false
): string {
  if (conservative) return REDACTED;
  let output = value.slice(0, 8_000);
  output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url, secrets));
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    output = output.split(secret).join(REDACTED);
    try { output = output.split(encodeURIComponent(secret)).join(REDACTED); } catch { /* malformed input */ }
  }
  output = output
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\b(token|access_token|refresh_token|id_token|code|key|secret|password|signature|session)\s*[:=]\s*[^\s,;|]+/gi, "$1=[redacted]");

  // Home-directory paths are masked because they leak the operator's identity
  // into journals. A path the caller supplied and must act on (a recording's
  // output file) is not a leak, so it is echoed back intact.
  if (keepHomePaths) return output;

  return output
    .replace(/\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"']+/gi, (path) => /\\\.dev-browser\\tmp\\/i.test(path) ? path : "[path]")
    .replace(/\/(?:home|Users)\/[^\s"']+/g, (path) => /\/\.dev-browser\/tmp\//.test(path) ? path : "[path]");
}

export function redactSensitive(value: unknown, options: RedactionOptions = {}): unknown {
  const secrets = new Set<string>();
  for (const secret of (options.secrets ?? []).slice(0, MAX_SECRETS)) addSecret(secrets, secret);
  const discovery: DiscoveryBudget = {
    nodes: 0,
    incomplete: (options.secrets?.length ?? 0) > MAX_SECRETS,
    values: new WeakMap(),
  };
  collectSecrets(value, secrets, new WeakSet(), discovery);
  const seen = new WeakMap<object, unknown>();
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, key = "", depth = 0): unknown => {
    if (++nodes > MAX_REDACTION_NODES || depth > 12) return "[truncated]";
    if (typeof current === "string") {
      if (options.allowConfirmationToken && /^confirmationtoken$/i.test(key)) return current.slice(0, 200);
      if (SENSITIVE_KEY.test(key) || FILE_CONTENT_KEY.test(key)) return REDACTED;
      if (options.allowOutputPath && /^path$/i.test(key))
        return safeString(current, secrets, discovery.incomplete, true);
      if (CONTROL_STRING_VALUE_KEY.test(key)) return safeString(current, secrets, false);
      return safeString(current, secrets, discovery.incomplete);
    }
    if (current === null || typeof current === "boolean") return current;
    if (current === undefined) return undefined;
    if (typeof current === "number") return Number.isFinite(current) ? current : null;
    if (typeof current !== "object") return String(current).slice(0, 200);
    if (active.has(current)) return "[circular]";
    if (seen.has(current)) return seen.get(current);
    if (Array.isArray(current)) {
      const result: unknown[] = []; seen.set(current, result); active.add(current);
      for (let index = 0; index < Math.min(current.length, 500); index += 1)
        result.push(visit(discoveredProperty(current, String(index), discovery), key, depth + 1));
      if (current.length > 500) result.push("[truncated]");
      active.delete(current);
      return result;
    }
    const result: Record<string, unknown> = {}; seen.set(current, result); active.add(current);
    const completed = forEachOwnProperty(current, MAX_OBJECT_PROPERTIES, (childKey) => {
      const outputKey = options.allowConfirmationToken && /^confirmationtoken$/i.test(childKey)
        ? childKey
        : CONTROL_KEY.test(childKey)
          ? childKey
          : safeString(childKey.slice(0, 200), secrets, discovery.incomplete);
      result[outputKey] = visit(discoveredProperty(current, childKey, discovery), childKey, depth + 1);
    });
    if (!completed) result["[truncated]"] = "[truncated]";
    active.delete(current);
    return result;
  };
  return visit(value);
}

export { REDACTED };
