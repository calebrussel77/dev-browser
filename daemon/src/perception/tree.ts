import type { PerceptionElement } from "./collector.js";

export interface TreeResult {
  tree: string;
  elements: PerceptionElement[];
  omittedNodes: number;
  consumedNodes: number;
}

export function buildCompactTree(
  records: PerceptionElement[],
  maxNodes: number,
  maxChars: number,
  offset = 0,
  maxDepth = 50,
  breadth = 500
): TreeResult {
  const selected: PerceptionElement[] = [];
  const lines: string[] = [];
  let chars = 0;
  const baseDepth = records[offset]?.depth ?? 0;
  const depthCounts = new Map<number, number>();

  for (const record of records.slice(offset)) {
    if (selected.length >= maxNodes) break;
    const relativeDepth = Math.max(0, record.depth - baseDepth);
    if (relativeDepth > maxDepth) break;
    const depthCount = depthCounts.get(relativeDepth) ?? 0;
    if (depthCount >= breadth) break;
    const displayed = { ...record, depth: relativeDepth };
    const state = [
      record.disabled ? "disabled" : "",
      record.checked === true ? "checked" : record.checked === "mixed" ? "mixed" : "",
      record.expanded === true ? "expanded" : record.expanded === false ? "collapsed" : "",
      record.scrollable ? "scrollable" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const line = `${"  ".repeat(displayed.depth)}${displayed.ref ? `[${displayed.ref}] ` : ""}${displayed.role}${
      displayed.name ? ` ${JSON.stringify(displayed.name)}` : ""
    }${state ? ` (${state})` : ""}`;
    const addedChars = line.length + (lines.length > 0 ? 1 : 0);
    if (chars + addedChars > maxChars) {
      if (selected.length > 0) break;
      selected.push(displayed);
      lines.push(line.slice(0, maxChars));
      chars = maxChars;
      depthCounts.set(relativeDepth, depthCount + 1);
      break;
    }
    selected.push(displayed);
    lines.push(line);
    chars += addedChars;
    depthCounts.set(relativeDepth, depthCount + 1);
  }

  return {
    tree: lines.join("\n"),
    elements: selected,
    omittedNodes: Math.max(0, records.length - offset - selected.length),
    consumedNodes: selected.length,
  };
}
