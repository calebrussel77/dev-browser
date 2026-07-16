import { z } from "zod";

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

const InteractiveActionSchema = z.union([
  z.object({ kind: z.literal("pages") }),
  z.object({
    kind: z.literal("navigate"),
    url: z.string().url(),
  }),
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
  z.object({ kind: z.literal("shot") }),
]);

const InteractiveRequestSchema = RequestBaseSchema.extend({
  type: z.literal("interactive"),
  browser: z.string().min(1).default("default"),
  page: z.string().min(1).default("main"),
  action: InteractiveActionSchema,
  shot: z.string().min(1).optional(),
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
export type InteractiveRequest = z.infer<typeof InteractiveRequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;

type ParseSuccess = { success: true; request: Request };
type ParseFailure = { success: false; error: string; id?: string };

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
