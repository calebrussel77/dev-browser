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
const ScopedRefSchema = z.string().min(2).max(32).regex(/^(?:F\d+:)?R\d+$/);
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
    ref: ScopedRefSchema,
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
const RetryPolicySchema = z.enum(["never", "safe", "once"]);
const RefSchema = ScopedRefSchema;
const PrimitiveBaseSchema = StateGuardSchema.merge(WaitableActionSchema);
const RefPrimitiveSchema = PrimitiveBaseSchema.extend({ ref: RefSchema });
const ScrollActionSchema = PrimitiveBaseSchema.extend({
  kind: z.literal("scroll"),
  ref: RefSchema.optional(),
  deltaX: z.number().finite().min(-100_000).max(100_000).optional(),
  deltaY: z.number().finite().min(-100_000).max(100_000).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  pages: z.number().int().min(1).max(50).optional(),
  until: z.string().regex(/^(text|role):.{1,2000}$/).optional(),
  maxSteps: z.number().int().min(1).max(50).optional(),
}).superRefine((value, context) => {
  const modes = [value.ref !== undefined, value.deltaX !== undefined || value.deltaY !== undefined,
    value.direction !== undefined, value.until !== undefined].filter(Boolean).length;
  if (modes !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one scroll mode is required" });
  if ((value.direction === undefined) !== (value.pages === undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "direction and pages are required together" });
  if ((value.until === undefined) !== (value.maxSteps === undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "until and maxSteps are required together" });
});
const SelectActionSchema = RefPrimitiveSchema.extend({
  kind: z.literal("select"), value: z.string().max(2000).optional(), label: z.string().max(2000).optional(),
}).superRefine((value, context) => {
  if ((value.value === undefined) === (value.label === undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of value or label is required" });
});
const HistoryNavigationActionSchema = PrimitiveBaseSchema.extend({
  kind: z.enum(["back", "forward", "reload"]),
});
const UploadActionSchema = RefPrimitiveSchema.extend({
  kind: z.literal("upload"),
  file: z.string().min(1).max(32_768),
});

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
  ref: ScopedRefSchema,
  method: z.enum(["mouse", "locator"]).default("mouse"),
  expectText: z.string().min(1).optional(),
  waitForText: WaitValueSchema.optional(),
  retry: RetryPolicySchema.optional(),
});

const InteractiveClickByCoordinatesSchema = StateGuardSchema.merge(WaitableActionSchema).extend({
  kind: z.literal("click"),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  method: z.literal("mouse").default("mouse"),
  expectText: z.string().min(1).optional(),
  waitForText: WaitValueSchema.optional(),
  retry: RetryPolicySchema.optional(),
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

const StructuredFindSchema = z.object({
  kind: z.literal("find"),
  query: z.string().min(1).max(2_000).optional(),
  role: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(2_000).optional(),
  nameMode: z.enum(["exact", "contains"]).default("exact"),
  within: z.string().min(1).max(500).optional(),
  near: z.string().min(1).max(2_000).optional(),
  frame: z.string().min(1).max(200).optional(),
  scope: z.enum(["visible", "viewport", "document"]).default("visible"),
  states: z.array(z.enum(["enabled", "disabled", "checked", "unchecked", "expanded", "collapsed", "selected"])).max(7).default([]),
  index: z.number().int().nonnegative().max(999).optional(),
  limit: z.number().int().positive().max(50).default(10),
}).superRefine((value, context) => {
  if (!value.query && !value.role && !value.name && !value.within && !value.near && !value.frame && value.states.length === 0)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "find requires a query or structured filter" });
  if (!value.name && value.nameMode !== "exact")
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nameMode"], message: "nameMode requires name" });
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
  StructuredFindSchema,
  InteractiveClickByRefSchema,
  InteractiveClickByCoordinatesSchema,
  RefPrimitiveSchema.extend({ kind: z.literal("focus") }),
  RefPrimitiveSchema.extend({ kind: z.literal("press"), key: z.string().min(1).max(64).regex(/^[A-Za-z0-9+ -]+$/) }),
  RefPrimitiveSchema.extend({ kind: z.literal("paste"), text: z.string().max(1_000_000) }),
  ScrollActionSchema,
  SelectActionSchema,
  RefPrimitiveSchema.extend({ kind: z.literal("check") }),
  RefPrimitiveSchema.extend({ kind: z.literal("uncheck") }),
  RefPrimitiveSchema.extend({ kind: z.literal("hover") }),
  PrimitiveBaseSchema.extend({ kind: z.literal("drag"), from: RefSchema, to: RefSchema }),
  HistoryNavigationActionSchema,
  UploadActionSchema,
  StateGuardSchema.merge(WaitableActionSchema).extend({
    kind: z.literal("type"),
    ref: ScopedRefSchema.optional(),
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
    ref: ScopedRefSchema.optional(),
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
}).superRefine((value, context) => {
  if (value.action.kind === "paste" && (value.shot !== undefined || value.annotate)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "paste cannot create screenshots or annotations" });
  }
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
    ? Omit<Action, "strictState" | "padding" | "scope" | "nameMode" | "states"> & { strictState?: boolean } & (Action extends {
          kind: "shot";
        }
          ? { padding?: number }
          : unknown) & (Action extends { kind: "find" }
          ? { scope?: "visible" | "viewport" | "document"; nameMode?: "exact" | "contains"; states?: ("enabled" | "disabled" | "checked" | "unchecked" | "expanded" | "collapsed" | "selected")[] }
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

  if (
    result.data.type === "interactive" &&
    result.data.protocolVersion === 2 &&
    result.data.action.kind === "click" &&
    !result.data.action.retry
  ) {
    result.data.action.retry = "never";
  }

  return {
    success: true,
    request: result.data,
  };
}

export function serialize(message: Response): string {
  return `${JSON.stringify(ResponseSchema.parse(message))}\n`;
}
