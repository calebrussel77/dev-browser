import type { PerceptionElement } from "./perception/collector.js";

export type TargetScope = "visible" | "viewport" | "document";
export type TargetState =
  | "enabled"
  | "disabled"
  | "checked"
  | "unchecked"
  | "expanded"
  | "collapsed"
  | "selected";
export interface TargetFilters {
  query?: string;
  role?: string;
  name?: string;
  nameMode?: "exact" | "contains";
  within?: string;
  near?: string;
  frame?: string;
  scope: TargetScope;
  states: TargetState[];
  index?: number;
}
export interface TargetMatch extends PerceptionElement {
  score: number;
  confidence: "high" | "medium" | "low";
  matchedBecause: string[];
}
export interface TargetAmbiguity {
  ambiguous: boolean;
  topScore: number | null;
  scoreGap: number | null;
  reason: string;
}

export const normalizeMatchText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Find's `within` semantic: a case/diacritic/punctuation-insensitive
 * substring match against a landmark descriptor. Scoped observation, text,
 * and assert reuse this exact matching semantic for their scope roots.
 */
export function landmarkScopeMatches(landmark: string, within: string): boolean {
  return normalizeMatchText(landmark).includes(normalizeMatchText(within));
}

/**
 * A stable logical identity for an element, used to de-duplicate a virtualized
 * container's recycled DOM nodes across scroll steps (find's --scroll-container
 * auto-scan). Prefers the most stable signal available: test-id, then href,
 * then role+name. Two recycled nodes that render the same logical row must
 * resolve to the same identity even though their `ref` changes between scans.
 */
export function elementIdentity(element: PerceptionElement): string {
  const testId = element.stableAttributes?.testId;
  if (testId) return `testid:${testId}`;
  const href = element.stableAttributes?.href;
  if (href) return `href:${href}`;
  return `role:${normalizeMatchText(element.role)}|name:${normalizeMatchText(element.name)}`;
}

const normalize = normalizeMatchText;
const refOrder = (ref: string) => Number(ref.replace(/\D/g, "")) || Number.MAX_SAFE_INTEGER;

function hasState(element: PerceptionElement, state: TargetState): boolean {
  if (state === "enabled") return !element.disabled;
  if (state === "disabled") return element.disabled;
  if (state === "checked") return element.checked === true;
  if (state === "unchecked") return element.checked === false;
  if (state === "expanded") return element.expanded === true;
  if (state === "collapsed") return element.expanded === false;
  return element.selected === true;
}

export function findTargets(
  elements: PerceptionElement[],
  filters: TargetFilters,
  limit: number
): { matches: TargetMatch[]; ambiguity: TargetAmbiguity } {
  const matches = elements
    .flatMap((element): TargetMatch[] => {
      if (filters.scope === "visible" && !element.visible) return [];
      if (filters.scope === "viewport" && (!element.visible || !element.inViewport)) return [];
      const reasons: string[] = [];
      let score = 0;
      if (filters.role) {
        if (normalize(element.role) !== normalize(filters.role)) return [];
        reasons.push(`role=${filters.role}`);
        score += 30;
      }
      if (filters.name) {
        const actual = normalize(element.name),
          expected = normalize(filters.name);
        const mode = filters.nameMode ?? "exact";
        if (mode === "exact" ? actual !== expected : !actual.includes(expected)) return [];
        reasons.push(`name:${mode}=${filters.name}`);
        score += mode === "exact" ? 100 : 60;
      }
      if (filters.within) {
        if (!landmarkScopeMatches(element.landmark, filters.within)) return [];
        reasons.push(`within=${filters.within}`);
        score += 25;
      }
      if (filters.near) {
        const nearby = normalize(
          [element.nearby.heading, element.nearby.label, element.nearby.context].join(" ")
        );
        if (!nearby.includes(normalize(filters.near))) return [];
        reasons.push(`near=${filters.near}`);
        score += 20;
      }
      if (filters.frame) {
        if (normalize(element.frameId) !== normalize(filters.frame)) return [];
        reasons.push(`frame=${filters.frame}`);
        score += 20;
      } else if (element.frameId !== "F0") {
        reasons.push(`frame=${element.frameId}`);
      }
      for (const state of filters.states) {
        if (!hasState(element, state)) return [];
        reasons.push(`state=${state}`);
        score += 10;
      }
      if (filters.query) {
        const query = normalize(filters.query),
          haystack = normalize(
            [
              element.name,
              element.role,
              element.landmark,
              element.nearby.heading,
              element.nearby.label,
              element.nearby.context,
            ].join(" ")
          );
        const tokens = query.split(" ").filter(Boolean);
        const matchedTokens = tokens.filter((token) => haystack.includes(token));
        if (matchedTokens.length === 0) return [];
        score += matchedTokens.reduce(
          (total, token) => total + (normalize(element.name).includes(token) ? 20 : 8),
          0
        );
        if (normalize(element.name) === query) score += 80;
        reasons.push(`query:${filters.query}`);
      }
      return [
        {
          ...element,
          score,
          confidence: score >= 100 ? "high" : score >= 50 ? "medium" : "low",
          matchedBecause: reasons,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        refOrder(left.ref) - refOrder(right.ref) ||
        left.ref.localeCompare(right.ref)
    );

  const topScore = matches[0]?.score ?? null;
  const scoreGap = matches.length > 1 ? matches[0]!.score - matches[1]!.score : null;
  if (filters.index !== undefined) {
    const selected = matches[filters.index];
    return {
      matches: selected ? [selected] : [],
      ambiguity: {
        ambiguous: false,
        topScore: selected?.score ?? topScore,
        scoreGap,
        reason: "explicit-index",
      },
    };
  }
  const ambiguous = matches.length > 1 && scoreGap === 0;
  return {
    matches: matches.slice(0, limit),
    ambiguity: {
      ambiguous,
      topScore,
      scoreGap,
      reason: ambiguous
        ? "top-candidates-tied"
        : matches.length === 0
          ? "no-match"
          : "score-separated",
    },
  };
}
