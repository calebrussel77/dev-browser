import { z } from "zod";
import { redactSensitive } from "./redaction.js";

export const AGENT_PROTOCOL_VERSION = 2 as const;
export const AgentProtocolVersionSchema = z.union([z.literal(1), z.literal(2)]);

export const AgentErrorCodeSchema = z.enum([
  "STALE_REF",
  "STALE_STATE",
  "AMBIGUOUS_TARGET",
  "TARGET_MISSING",
  "TARGET_HIDDEN",
  "TARGET_OBSCURED",
  "TARGET_DISABLED",
  "UNSUPPORTED_CONTEXT",
  "WAIT_TIMEOUT",
  "PAGE_CLOSED",
  "FRAME_DETACHED",
  "POPUP_OPENED",
  "DOWNLOAD_FAILED",
  "LEASE_CONFLICT",
  "CDP_DISCOVERY_FAILED",
  "CDP_ATTACH_FAILED",
  "RENDERER_UNRESPONSIVE",
  "DAEMON_VERSION_MISMATCH",
  "PROTOCOL_VERSION_MISMATCH",
  "CONFIRMATION_INVALID",
  "ASSERTION_FAILED",
]);

export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

const MAX_ERROR_MESSAGE_LENGTH = 4_000;
const MAX_DETAILS_LENGTH = 16_000;
const MAX_NEXT_COMMAND_LENGTH = 500;

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 12 || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every((item) => isJsonSafe(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value as Record<string, unknown>).every((item) =>
    isJsonSafe(item, depth + 1)
  );
}

function isBoundedJson(value: unknown): boolean {
  if (!isJsonSafe(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= MAX_DETAILS_LENGTH;
  } catch {
    return false;
  }
}

const JsonSafeDetailsSchema = z
  .unknown()
  .refine(isBoundedJson, `details must be JSON-safe and at most ${MAX_DETAILS_LENGTH} characters`);

export const AgentErrorSchema = z.object({
  code: AgentErrorCodeSchema,
  message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
  recoverable: z.boolean(),
  details: JsonSafeDetailsSchema.optional(),
  nextCommands: z.array(z.string().min(1).max(MAX_NEXT_COMMAND_LENGTH)).max(5).optional(),
});

export type AgentError = z.infer<typeof AgentErrorSchema>;

export class AgentProtocolError extends Error {
  readonly code: AgentErrorCode;
  readonly recoverable: boolean;
  readonly details?: unknown;
  readonly nextCommands?: string[];

  constructor(
    code: AgentErrorCode,
    message: string,
    recoverable: boolean,
    options: { details?: unknown; nextCommands?: string[] } = {}
  ) {
    super(message);
    this.name = "AgentProtocolError";
    const parsed = AgentErrorSchema.parse(redactSensitive({ code, message, recoverable, ...options }));
    this.message = parsed.message;
    this.code = parsed.code;
    this.recoverable = parsed.recoverable;
    this.details = parsed.details;
    this.nextCommands = parsed.nextCommands;
  }

  toAgentError(): AgentError {
    return AgentErrorSchema.parse({
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
      nextCommands: this.nextCommands,
    });
  }
}

export function parseAgentError(value: unknown): AgentError {
  return AgentErrorSchema.parse(value);
}

export function toAgentError(
  error: unknown,
  fallbackCode: AgentErrorCode = "RENDERER_UNRESPONSIVE"
): AgentError {
  if (error instanceof AgentProtocolError) {
    return error.toAgentError();
  }

  const typed = AgentErrorSchema.safeParse(error);
  if (typed.success) return typed.data;

  const rawMessage = redactSensitive(error instanceof Error ? error.message : String(error)) as string;

  return AgentErrorSchema.parse({
    code: fallbackCode,
    message: (rawMessage || "Unknown daemon error").slice(0, MAX_ERROR_MESSAGE_LENGTH),
    recoverable: false,
  });
}

export const InteractiveSuccessSchema = z
  .object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    ok: z.literal(true),
    requestId: z.string().min(1),
    browser: z.string().min(1),
    page: z.string().min(1),
    action: z.string().min(1),
  })
  .passthrough();

export const InteractiveFailureSchema = z.object({
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  ok: z.literal(false),
  requestId: z.string().min(1),
  browser: z.string().min(1).optional(),
  page: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  error: AgentErrorSchema,
});

export type InteractiveSuccess = z.infer<typeof InteractiveSuccessSchema>;
export type InteractiveFailure = z.infer<typeof InteractiveFailureSchema>;

export function buildInteractiveSuccess(input: {
  requestId: string;
  browser: string;
  page: string;
  action: string;
  result: Record<string, unknown>;
}): InteractiveSuccess {
  return InteractiveSuccessSchema.parse(redactSensitive({
    ...input.result,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    ok: true,
    requestId: input.requestId,
    browser: input.browser,
    page: input.page,
    action: input.action,
  }, { allowConfirmationToken: input.action === "confirm" }));
}

export function buildInteractiveFailure(input: {
  requestId: string;
  browser?: string;
  page?: string;
  action?: string;
  error: unknown;
}): InteractiveFailure {
  return InteractiveFailureSchema.parse(redactSensitive({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    ok: false,
    requestId: input.requestId,
    browser: input.browser,
    page: input.page,
    action: input.action,
    error: toAgentError(input.error),
  }));
}

export function parseInteractiveSuccess(value: unknown): InteractiveSuccess {
  return InteractiveSuccessSchema.parse(value);
}

export function parseInteractiveFailure(value: unknown): InteractiveFailure {
  return InteractiveFailureSchema.parse(value);
}

export function agentErrorExitCode(code: AgentErrorCode): number {
  const actionabilityCodes: AgentErrorCode[] = [
    "STALE_REF",
    "STALE_STATE",
    "AMBIGUOUS_TARGET",
    "TARGET_MISSING",
    "TARGET_HIDDEN",
    "TARGET_OBSCURED",
    "TARGET_DISABLED",
    "UNSUPPORTED_CONTEXT",
    "ASSERTION_FAILED",
  ];
  if (actionabilityCodes.includes(code)) {
    return 3;
  }
  if (code === "WAIT_TIMEOUT") return 4;
  if (code === "LEASE_CONFLICT") return 5;
  if (code === "DOWNLOAD_FAILED") return 7;
  if (code === "CONFIRMATION_INVALID") return 8;
  return 6;
}
