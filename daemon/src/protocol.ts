import { z } from "zod";
import {
  AgentErrorSchema,
  AgentProtocolError,
  AgentProtocolVersionSchema,
  type AgentError,
} from "./agent-protocol.js";

const RequestBaseSchema = z.object({
  id: z.string().min(1),
});

const ExecuteRequestSchema = RequestBaseSchema.extend({
  type: z.literal("execute"),
  browser: z.string().min(1).default("default"),
  script: z.string(),
  headless: z.boolean().optional(),
  ignoreHTTPSErrors: z.boolean().optional(),
  connect: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const InteractiveClickByRefSchema = z.object({
  kind: z.literal("click"),
  ref: z.string().regex(/^R\d+$/),
  method: z.enum(["mouse", "locator"]).default("mouse"),
  expectText: z.string().min(1).optional(),
  waitForText: z.string().min(1).optional(),
});

const InteractiveClickByCoordinatesSchema = z.object({
  kind: z.literal("click"),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  method: z.literal("mouse").default("mouse"),
  expectText: z.string().min(1).optional(),
  waitForText: z.string().min(1).optional(),
});

const ObserveOptionsSchema = z.object({
  full: z.boolean().default(false),
  delta: z.boolean().default(false),
  track: z.string().min(1).max(200).default("default"),
  maxNodes: z.number().int().positive().max(1_000).default(100),
  maxChars: z.number().int().positive().max(100_000).default(12_000),
  depth: z.number().int().positive().max(50).default(12),
  breadth: z.number().int().positive().max(500).default(50),
  continuation: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

const InteractiveActionSchema = z.union([
  z.object({ kind: z.literal("pages") }),
  z.object({
    kind: z.literal("navigate"),
    url: z.string().url(),
  }),
  ObserveOptionsSchema.extend({ kind: z.literal("observe") }),
  z.object({
    kind: z.literal("read"),
    limit: z.number().int().positive().max(500).default(100),
    depth: z.number().int().positive().max(50).default(12),
  }),
  z.object({
    kind: z.literal("find"),
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).default(10),
  }),
  InteractiveClickByRefSchema,
  InteractiveClickByCoordinatesSchema,
  z.object({
    kind: z.literal("type"),
    ref: z
      .string()
      .regex(/^R\d+$/)
      .optional(),
    text: z.string(),
    clear: z.boolean().default(false),
    delayMs: z.number().int().nonnegative().max(1_000).default(0),
  }),
  z.object({
    kind: z.literal("confirm"),
    expectText: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("shot"),
    ref: z
      .string()
      .regex(/^R\d+$/)
      .optional(),
    padding: z.number().int().nonnegative().max(1_000).default(32),
  }),
]);

const InteractiveRequestSchema = RequestBaseSchema.extend({
  type: z.literal("interactive"),
  protocolVersion: AgentProtocolVersionSchema.default(1),
  browser: z.string().min(1).default("default"),
  page: z.string().min(1).default("main"),
  action: InteractiveActionSchema,
  shot: z.string().min(1).optional(),
  annotate: z.boolean().default(false),
  fullPage: z.boolean().default(false),
  headless: z.boolean().optional(),
  ignoreHTTPSErrors: z.boolean().optional(),
  connect: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const BrowsersRequestSchema = RequestBaseSchema.extend({
  type: z.literal("browsers"),
});

const BrowserStopRequestSchema = RequestBaseSchema.extend({
  type: z.literal("browser-stop"),
  browser: z.string().min(1),
});

const StatusRequestSchema = RequestBaseSchema.extend({
  type: z.literal("status"),
});

const InstallRequestSchema = RequestBaseSchema.extend({
  type: z.literal("install"),
});

const StopRequestSchema = RequestBaseSchema.extend({
  type: z.literal("stop"),
});

const RequestSchema = z.discriminatedUnion("type", [
  ExecuteRequestSchema,
  InteractiveRequestSchema,
  BrowsersRequestSchema,
  BrowserStopRequestSchema,
  StatusRequestSchema,
  InstallRequestSchema,
  StopRequestSchema,
]);

const ResponseBaseSchema = z.object({
  id: z.string().min(1),
});

const StdoutMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("stdout"),
  data: z.string(),
});

const StderrMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("stderr"),
  data: z.string(),
});

const CompleteMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("complete"),
  success: z.literal(true),
});

const ErrorMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("error"),
  message: z.string(),
  exitCode: z.number().int().min(1).max(255).optional(),
  error: AgentErrorSchema.optional(),
  data: z.unknown().optional(),
});

const ResultMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("result"),
  data: z.unknown(),
});

const ResponseSchema = z.discriminatedUnion("type", [
  StdoutMessageSchema,
  StderrMessageSchema,
  CompleteMessageSchema,
  ErrorMessageSchema,
  ResultMessageSchema,
]);

type Request = z.infer<typeof RequestSchema>;
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
type ParsedInteractiveAction = z.infer<typeof InteractiveActionSchema>;
type ParsedShotAction = Extract<ParsedInteractiveAction, { kind: "shot" }>;
export type InteractiveRequest = Omit<
  z.infer<typeof InteractiveRequestSchema>,
  "protocolVersion" | "annotate" | "fullPage" | "action"
> & {
  protocolVersion?: 1 | 2;
  annotate?: boolean;
  fullPage?: boolean;
  action:
    | Exclude<ParsedInteractiveAction, ParsedShotAction>
    | (Omit<ParsedShotAction, "padding"> & { padding?: number });
};
export type Response = z.infer<typeof ResponseSchema>;

type ParseSuccess = { success: true; request: Request };
type ParseFailure = { success: false; error: string; id?: string; agentError?: AgentError };

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function extractId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeId = (value as { id?: unknown }).id;
  return typeof maybeId === "string" && maybeId.length > 0 ? maybeId : undefined;
}

export function parseRequest(line: string): ParseSuccess | ParseFailure {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Invalid JSON request",
    };
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { type?: unknown }).type === "interactive" &&
    "protocolVersion" in parsed &&
    (parsed as { protocolVersion?: unknown }).protocolVersion !== 1 &&
    (parsed as { protocolVersion?: unknown }).protocolVersion !== 2
  ) {
    const agentError = new AgentProtocolError(
      "PROTOCOL_VERSION_MISMATCH",
      "Unsupported agent protocol version; supported versions are 1 and 2",
      false,
      { nextCommands: ["dev-browser schema --json"] }
    ).toAgentError();
    return {
      success: false,
      error: agentError.message,
      id: extractId(parsed),
      agentError,
    };
  }

  const result = RequestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: describeZodError(result.error),
      id: extractId(parsed),
    };
  }

  return {
    success: true,
    request: result.data,
  };
}

export function serialize(message: Response): string {
  return `${JSON.stringify(ResponseSchema.parse(message))}\n`;
}
