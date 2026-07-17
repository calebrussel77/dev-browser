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

const StateGuardSchema = z.object({
  fromState: z
    .string()
    .regex(/^doc-\d+:\d+$/)
    .optional(),
  strictState: z.boolean().default(false),
});

const WAIT_MATCH_MAX_LENGTH = 2_000;

function isSafeRegex(value: string): boolean {
  if (value.length > WAIT_MATCH_MAX_LENGTH) return false;
  try {
    new RegExp(value);
  } catch {
    return false;
  }
  return !(
    /\\[1-9]/.test(value) ||
    /\(\?[=!<]/.test(value) ||
    /\)(?:\*|\+|\{\d)/.test(value) ||
    /(?:\*|\+|\{\d+(?:,\d*)?\})[^)]*\)(?:\*|\+|\{)/.test(value) ||
    /\([^)]*(?:\*|\+|\{\d+(?:,\d*)?\})[^)]*\)(?:\*|\+|\{)/.test(value)
  );
}

const WaitValueSchema = z.string().min(1).max(WAIT_MATCH_MAX_LENGTH);
const WaitMatchSchema = z.enum(["exact", "contains", "glob", "safe-regex"]);
const MatchFieldsSchema = z
  .object({
    match: WaitMatchSchema,
    value: WaitValueSchema,
  })
  .superRefine((value, context) => {
    if (value.match === "safe-regex" && !isSafeRegex(value.value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "unsafe regular expression",
      });
    }
  });

const TextWaitConditionSchema = z
  .object({
    kind: z.literal("text"),
    state: z.enum(["visible", "hidden"]),
    scope: z.enum(["body", "dialog", "toast"]),
  })
  .and(MatchFieldsSchema);
const UrlWaitConditionSchema = z.object({ kind: z.literal("url") }).and(MatchFieldsSchema);
const RefWaitConditionSchema = z
  .object({
    kind: z.literal("ref"),
    ref: z.string().regex(/^R\d+$/),
    state: z.enum([
      "attached",
      "detached",
      "visible",
      "hidden",
      "enabled",
      "disabled",
      "valueChanged",
      "attributeChanged",
      "stateChanged",
    ]),
    attribute: z.string().min(1).max(200).optional(),
    expected: z.string().max(WAIT_MATCH_MAX_LENGTH).optional(),
  })
  .superRefine((value, context) => {
    if (value.state === "attributeChanged" && !value.attribute) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attribute"],
        message: "attribute is required",
      });
    }
    if (value.state !== "attributeChanged" && value.state !== "stateChanged" && value.attribute) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attribute"],
        message: "attribute is only valid for changed state conditions",
      });
    }
  });
const SurfaceWaitConditionSchema = z.object({
  kind: z.enum(["dialog", "toast"]),
  state: z.enum(["opened", "closed"]),
});
const EventWaitConditionSchema = z.object({
  kind: z.enum(["popup", "download", "fileChooser"]),
});
const NavigationWaitConditionSchema = z.object({
  kind: z.literal("navigation"),
  state: z.enum(["navigation", "document"]),
});
const ResponseWaitConditionSchema = z
  .object({
    kind: z.literal("response"),
    method: z.string().min(1).max(20).optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .and(MatchFieldsSchema);
const FailedRequestWaitConditionSchema = z
  .object({
    kind: z.literal("failedRequest"),
    method: z.string().min(1).max(20).optional(),
  })
  .and(MatchFieldsSchema);
const NetworkIdleWaitConditionSchema = z.object({
  kind: z.literal("networkIdle"),
  specialized: z.literal(true),
  idleMs: z.number().int().min(1).max(30_000).default(500),
});

export const WaitConditionSchema = z.union([
  TextWaitConditionSchema,
  UrlWaitConditionSchema,
  RefWaitConditionSchema,
  SurfaceWaitConditionSchema,
  EventWaitConditionSchema,
  NavigationWaitConditionSchema,
  ResponseWaitConditionSchema,
  FailedRequestWaitConditionSchema,
  NetworkIdleWaitConditionSchema,
]);
export const WaitSpecSchema = z.object({
  mode: z.enum(["all", "any"]).default("all"),
  timeoutMs: z.number().int().min(1).max(120_000),
  conditions: z.array(WaitConditionSchema).min(1).max(20),
});
export type WaitCondition = z.infer<typeof WaitConditionSchema>;
export type WaitSpec = z.infer<typeof WaitSpecSchema>;

const WaitableActionSchema = z.object({ wait: WaitSpecSchema.optional() });

const ExecuteRequestSchema = RequestBaseSchema.extend({
  type: z.literal("execute"),
  browser: z.string().min(1).default("default"),
  script: z.string(),
  headless: z.boolean().optional(),
  ignoreHTTPSErrors: z.boolean().optional(),
  connect: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  session: z.string().min(1).max(500).optional(),
});

const InteractiveClickByRefSchema = StateGuardSchema.merge(WaitableActionSchema).extend({
  kind: z.literal("click"),
  ref: z.string().regex(/^R\d+$/),
  method: z.enum(["mouse", "locator"]).default("mouse"),
  expectText: z.string().min(1).optional(),
  waitForText: WaitValueSchema.optional(),
});

const InteractiveClickByCoordinatesSchema = StateGuardSchema.merge(WaitableActionSchema).extend({
  kind: z.literal("click"),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  method: z.literal("mouse").default("mouse"),
  expectText: z.string().min(1).optional(),
  waitForText: WaitValueSchema.optional(),
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
  WaitableActionSchema.extend({
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
  StateGuardSchema.merge(WaitableActionSchema).extend({
    kind: z.literal("type"),
    ref: z
      .string()
      .regex(/^R\d+$/)
      .optional(),
    text: z.string(),
    clear: z.boolean().default(false),
    delayMs: z.number().int().nonnegative().max(1_000).default(0),
  }),
  StateGuardSchema.extend({
    kind: z.literal("confirm"),
    expectText: z.string().min(1).optional(),
  }),
  StateGuardSchema.extend({
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
  session: z.string().min(1).max(500).optional(),
});

const SessionRequestSchema = z.union([
  RequestBaseSchema.extend({
    type: z.literal("session"),
    action: z.literal("open"),
    browser: z.string().min(1).default("default"),
    page: z.string().min(1),
    ttl: z.number().int().min(1).max(3600).default(300),
  }),
  RequestBaseSchema.extend({
    type: z.literal("session"),
    action: z.literal("renew"),
    session: z.string().min(1).max(500),
    ttl: z.number().int().min(1).max(3600).default(300),
  }),
  RequestBaseSchema.extend({
    type: z.literal("session"),
    action: z.literal("close"),
    session: z.string().min(1).max(500),
  }),
]);

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

const RequestSchema = z.union([
  ExecuteRequestSchema,
  InteractiveRequestSchema,
  BrowsersRequestSchema,
  BrowserStopRequestSchema,
  StatusRequestSchema,
  InstallRequestSchema,
  StopRequestSchema,
  SessionRequestSchema,
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
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
type ParsedInteractiveAction = z.infer<typeof InteractiveActionSchema>;
type InputInteractiveAction = ParsedInteractiveAction extends infer Action
  ? Action extends { kind: string }
    ? Omit<Action, "strictState" | "padding"> & { strictState?: boolean } & (Action extends {
          kind: "shot";
        }
          ? { padding?: number }
          : unknown)
    : never
  : never;
export type InteractiveRequest = Omit<
  z.infer<typeof InteractiveRequestSchema>,
  "protocolVersion" | "annotate" | "fullPage" | "action"
> & {
  protocolVersion?: 1 | 2;
  annotate?: boolean;
  fullPage?: boolean;
  action: InputInteractiveAction;
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

  if (
    result.data.type === "interactive" &&
    result.data.action.kind === "click" &&
    result.data.action.waitForText &&
    !result.data.action.wait
  ) {
    result.data.action.wait = {
      mode: "all",
      timeoutMs: Math.min(result.data.timeoutMs ?? 10_000, 5_000),
      conditions: [
        {
          kind: "text",
          state: "visible",
          scope: "body",
          match: "contains",
          value: result.data.action.waitForText,
        },
      ],
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
