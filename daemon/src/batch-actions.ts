import { toAgentError, type AgentError } from "./agent-protocol.js";
import type { BrowserManager } from "./browser-manager.js";
import {
  executeInteractiveAction,
  type InteractiveResult,
} from "./interactive-actions.js";
import type { BatchRequest } from "./protocol.js";

export interface BatchExecutionResult {
  steps: Array<{
    index: number;
    kind: string;
    ok: boolean;
    ms: number;
    result?: InteractiveResult;
    error?: AgentError;
  }>;
  final?: InteractiveResult;
  firstError?: AgentError;
}

export async function executeBatchActions(
  manager: BrowserManager,
  request: BatchRequest
): Promise<BatchExecutionResult> {
  const steps: BatchExecutionResult["steps"] = [];
  let firstError: AgentError | undefined;

  for (const [index, action] of request.steps.entries()) {
    const started = performance.now();
    try {
      const result = await executeInteractiveAction(manager, {
        id: `${request.id}:${index}`,
        type: "interactive",
        protocolVersion: 2,
        browser: request.browser,
        page: request.page,
        action,
        timeoutMs: request.timeoutMs,
        session: request.session,
      });
      steps.push({
        index,
        kind: action.kind,
        ok: true,
        ms: Math.round(performance.now() - started),
        result,
      });
    } catch (error) {
      const typed = toAgentError(error);
      firstError ??= typed;
      steps.push({
        index,
        kind: action.kind,
        ok: false,
        ms: Math.round(performance.now() - started),
        error: typed,
      });
      if (request.stopOnError) break;
    }
  }

  let final: InteractiveResult | undefined;
  if (request.observeAfter !== "none" && !firstError) {
    final = await executeInteractiveAction(manager, {
      id: `${request.id}:final`,
      type: "interactive",
      protocolVersion: 2,
      browser: request.browser,
      page: request.page,
      action: {
        kind: "observe",
        full: false,
        delta: request.observeAfter === "delta",
        track: "batch",
        maxNodes: 100,
        maxChars: 12_000,
        depth: 12,
        breadth: 50,
      },
      timeoutMs: request.timeoutMs,
      session: request.session,
    });
  }

  return { steps, final, firstError };
}
