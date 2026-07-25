import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  AgentProtocolError,
  agentErrorExitCode,
  buildInteractiveFailure,
  buildInteractiveSuccess,
  toAgentError,
} from "./agent-protocol.js";
import { BrowserManager } from "./browser-manager.js";
import { executeInteractiveAction } from "./interactive-actions.js";
import { getLatestStateId } from "./page-state.js";
import { authorizeExecuteRequest } from "./execute-policy.js";
import { createKeyedLock, createMutex } from "./lock.js";
import {
  getBrowsersDir,
  getDaemonEndpoint,
  getDevBrowserBaseDir,
  getPidPath,
  requiresDaemonEndpointCleanup,
} from "./local-endpoint.js";
import {
  parseRequest,
  serialize,
  type ExecuteRequest,
  type HandshakeRequest,
  type InteractiveRequest,
  type RestartRequest,
  type SessionRequest,
  type TraceRequest,
  type VideoRequest,
  type Response,
} from "./protocol.js";
import { videoRecordings } from "./video-recorder.js";
import { pageLeases } from "./sessions.js";
import { runScript } from "./sandbox/script-runner-quickjs.js";
import { ensureDevBrowserTempDir } from "./temp-files.js";
import { redactSensitive } from "./redaction.js";
import { traceCapabilityWarnings, traceSecretsForAction, traceStore } from "./trace-store.js";
import {
  buildRuntimeHandshake,
  currentProcessHash,
  EXPECTED_PLAYWRIGHT_VERSION,
  OperationTracker,
} from "./runtime-handshake.js";

const BASE_DIR = getDevBrowserBaseDir();
const SOCKET_PATH = getDaemonEndpoint();
const PID_PATH = getPidPath();
const BROWSERS_DIR = getBrowsersDir();
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const SOCKET_CLOSE_TIMEOUT_MS = 500;
const EMBEDDED_PACKAGE_JSON = JSON.stringify({
  name: "dev-browser-runtime",
  private: true,
  type: "module",
  dependencies: {
    playwright: EXPECTED_PLAYWRIGHT_VERSION,
    "playwright-core": EXPECTED_PLAYWRIGHT_VERSION,
    "quickjs-emscripten": "^0.32.0",
  },
});

const manager = new BrowserManager(BROWSERS_DIR);
const startedAt = Date.now();
const withBrowserLock = createKeyedLock<string>();
const withInstallLock = createMutex();
const clients = new Set<net.Socket>();
const operations = new OperationTracker();

let server: net.Server | null = null;
let shuttingDown: Promise<void> | null = null;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ScriptTimeoutError") {
      return error.message;
    }
    return error.stack ?? error.message;
  }

  return String(error);
}

async function writeMessage(socket: net.Socket, message: Response): Promise<void> {
  if (socket.destroyed) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const payload = serialize(message);
    socket.write(payload, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function closeServerInstance(serverToClose: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    serverToClose.close(() => {
      resolve();
    });
  });
}

async function closeClientSocket(socket: net.Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }, SOCKET_CLOSE_TIMEOUT_MS);
    timeout.unref();

    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };

    socket.once("close", finish);
    socket.once("error", finish);
    socket.end();
  });
}

function createMessageQueue(socket: net.Socket) {
  let queue = Promise.resolve();

  return {
    push(message: Response): Promise<void> {
      queue = queue.then(() => writeMessage(socket, message)).catch(() => undefined);
      return queue;
    },
    async drain(): Promise<void> {
      await queue;
    },
  };
}

async function prepareBrowser(request: {
  browser: string;
  connect?: string;
  headless?: boolean;
  ignoreHTTPSErrors?: boolean;
  timeoutMs?: number;
}): Promise<number> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  if (request.connect === "auto") {
    await manager.autoConnect(request.browser, {
      connectTimeoutMs: timeoutMs,
    });
  } else if (request.connect) {
    await manager.connectBrowser(request.browser, request.connect, {
      connectTimeoutMs: timeoutMs,
    });
  } else {
    await manager.ensureBrowser(request.browser, {
      headless: request.headless,
      ignoreHTTPSErrors: request.ignoreHTTPSErrors,
    });
  }

  return timeoutMs;
}

async function handleExecute(socket: net.Socket, request: ExecuteRequest): Promise<void> {
  await withBrowserLock(request.browser, async () => {
    const output = createMessageQueue(socket);

    try {
      authorizeExecuteRequest(request);
      const timeoutMs = await prepareBrowser(request);
      await runScript(
        request.script,
        manager,
        request.browser,
        {
          onStdout: (data) => {
            void output.push({
              id: request.id,
              type: "stdout",
              data,
            });
          },
          onStderr: (data) => {
            void output.push({
              id: request.id,
              type: "stderr",
              data,
            });
          },
        },
        {
          timeout: timeoutMs,
        }
      );

      await output.drain();
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
    } catch (error) {
      await output.drain().catch(() => undefined);
      if (error instanceof AgentProtocolError) {
        await writeMessage(socket, {
          id: request.id,
          type: "error",
          message: error.message,
          exitCode: agentErrorExitCode(error.code),
          error: error.toAgentError(),
        });
        return;
      }
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: formatError(error),
      });
    }
  });
}

async function handleInteractive(socket: net.Socket, request: InteractiveRequest): Promise<void> {
  await withBrowserLock(request.browser, async () => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const traceId = request.trace ? traceStore.allocateId() : undefined;
    const traceSecrets = traceSecretsForAction(request.action as unknown as Record<string, unknown>);
    let tracePage: Awaited<ReturnType<BrowserManager["getPage"]>> | undefined;
    let before: Record<string, unknown> | undefined;
    let beforeScreenshot: string | undefined;
    const traceWarnings: string[] = [];
    const diagnostics = {
      consoleErrors: [] as unknown[], pageErrors: [] as unknown[], failedRequests: [] as unknown[],
      responses: [] as unknown[], popup: [] as unknown[], download: [] as unknown[],
      fileChooser: [] as unknown[], navigation: [] as unknown[],
    };
    const boundedPush = (items: unknown[], value: unknown) => { if (items.length < 20) items.push(value); };
    const responseConditions = "wait" in request.action
      ? request.action.wait?.conditions.filter((condition) => condition.kind === "response") ?? []
      : [];
    const matchesResponseWait = (url: string, method: string, status: number) => responseConditions.some((condition) => {
      const urlMatches = condition.match === "exact" ? url === condition.value : url.includes(condition.value.replaceAll("*", ""));
      return urlMatches && (!condition.method || condition.method === method) && (!condition.status || condition.status === status);
    });
    const listeners = {
      console: (message: { type(): string; text(): string }) => { if (message.type() === "error") boundedPush(diagnostics.consoleErrors, message.text()); },
      pageerror: (error: Error) => boundedPush(diagnostics.pageErrors, error.message),
      requestfailed: (failed: { url(): string; method(): string; failure(): { errorText: string } | null }) => boundedPush(diagnostics.failedRequests, { url: failed.url(), method: failed.method(), error: failed.failure()?.errorText }),
      response: (response: { url(): string; status(): number; request(): { method(): string } }) => { const method = response.request().method(); if (response.status() >= 400 || matchesResponseWait(response.url(), method, response.status())) boundedPush(diagnostics.responses, { url: response.url(), status: response.status(), method }); },
      popup: (popup: { url(): string }) => boundedPush(diagnostics.popup, { url: popup.url() }),
      download: (download: { suggestedFilename(): string }) => boundedPush(diagnostics.download, { filename: download.suggestedFilename() }),
      filechooser: () => boundedPush(diagnostics.fileChooser, { opened: true }),
      framenavigated: (frame: { url(): string; parentFrame(): unknown }) => { if (!frame.parentFrame()) boundedPush(diagnostics.navigation, { url: frame.url() }); },
    };
    const detachTraceListeners = () => {
      if (!tracePage) return;
      for (const [event, listener] of Object.entries(listeners)) tracePage.off(event as never, listener as never);
    };
    const finishTrace = async (result?: Record<string, unknown>, error?: unknown) => {
      if (!traceId) return undefined;
      detachTraceListeners();
      const after = tracePage && !tracePage.isClosed()
        ? { url: tracePage.url(), stateId: getLatestStateId(tracePage) }
        : { closed: true };
      const record = await traceStore.save({
        actionId: request.id, action: request.action.kind, startedAt,
        finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        page: { browser: request.browser, target: request.page, before, after },
        resolvedTarget: result?.clicked ?? result?.typed ?? result?.uploaded ?? result?.targets,
        inputMethod: (result?.clicked as { method?: string } | undefined)?.method ?? (result?.attemptJournal as Array<{ inputMethod?: string }> | undefined)?.at(-1)?.inputMethod,
        screenshots: { requested: Boolean(request.shot), before: beforeScreenshot, after: result?.screenshotPath, artifacts: result?.artifacts },
        diagnostics, waitResult: result?.waitResult,
        attempts: result?.attemptJournal,
        events: { popup: result?.popup, download: result?.download, navigation: result?.navigation },
        error: error ? toAgentError(error) : undefined,
        recoveryHints: error ? toAgentError(error).nextCommands : result?.warnings,
        warnings: traceWarnings,
      }, traceId, traceSecrets);
      return { id: record.id, path: record.path, nextCommand: `dev-browser trace show ${record.id}` };
    };
    try {
      await prepareBrowser(request);
      if (traceId) {
        traceWarnings.push(...traceCapabilityWarnings(manager.getBrowser(request.browser)?.type));
        tracePage = await manager.getPage(request.browser, request.page);
        before = { url: tracePage.url(), stateId: getLatestStateId(tracePage) };
        for (const [event, listener] of Object.entries(listeners)) tracePage.on(event as never, listener as never);
        if (request.shot) {
          try {
            beforeScreenshot = await traceStore.artifactPath(traceId, "before.png");
            await tracePage.screenshot({ path: beforeScreenshot, type: "png" });
          } catch (screenshotError) {
            beforeScreenshot = undefined;
            traceWarnings.push(`Before screenshot unavailable: ${redactSensitive(formatError(screenshotError)) as string}`);
          }
        }
      }
      const result = await executeInteractiveAction(manager, request);
      if (traceWarnings.length) result.warnings = [...(result.warnings ?? []), ...traceWarnings];
      let trace;
      try { trace = await finishTrace(result as unknown as Record<string, unknown>); }
      catch (traceError) {
        detachTraceListeners();
        result.warnings = [...(result.warnings ?? []), `Trace unavailable: ${redactSensitive(formatError(traceError)) as string}`];
      }
      if (trace) (result as unknown as Record<string, unknown>).trace = trace;
      await writeMessage(socket, {
        id: request.id,
        type: "result",
        data:
          request.protocolVersion === 2
            ? buildInteractiveSuccess({
                requestId: request.id,
                browser: request.browser,
                page: request.page,
                action: request.action.kind,
                result: { ...result },
              })
            : result,
      });
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
    } catch (error) {
      let trace: Awaited<ReturnType<typeof finishTrace>>;
      try { trace = await finishTrace(undefined, error); }
      catch { detachTraceListeners(); }
      const action = request.action;
      const secrets = traceSecrets;
      if (request.protocolVersion === 2) {
        const agentError = toAgentError(error);
        if (trace) agentError.details = { ...(agentError.details ?? {}), trace };
        const failure = buildInteractiveFailure({
          requestId: request.id,
          browser: request.browser,
          page: request.page,
          action: request.action.kind,
          error: redactSensitive(agentError, { secrets }),
        });
        await writeMessage(socket, {
          id: request.id,
          type: "error",
          message: failure.error.message,
          exitCode: agentErrorExitCode(failure.error.code),
          error: failure.error,
          data: failure,
        });
        return;
      }
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: redactSensitive(formatError(error), { secrets }) as string,
      });
    }
  });
}

async function handleSession(socket: net.Socket, request: SessionRequest): Promise<void> {
  try {
    let data;
    if (request.action === "open") {
      await manager.getPage(request.browser, request.page);
      data = pageLeases.open(request.browser, request.page, request.ttl);
    } else if (request.action === "renew") {
      data = pageLeases.renew(request.session, request.ttl);
    } else {
      data = pageLeases.close(request.session);
    }
    await writeMessage(socket, { id: request.id, type: "result", data });
    await writeMessage(socket, { id: request.id, type: "complete", success: true });
  } catch (error) {
    const failure = buildInteractiveFailure({ requestId: request.id, error });
    await writeMessage(socket, {
      id: request.id,
      type: "error",
      message: failure.error.message,
      exitCode: agentErrorExitCode(failure.error.code),
      error: failure.error,
      data: failure,
    });
  }
}

async function handleVideo(socket: net.Socket, request: VideoRequest): Promise<void> {
  await withBrowserLock(request.browser, async () => {
    try {
      let data: Record<string, unknown>;
      if (request.action === "start") {
        await prepareBrowser(request);
        const page = await manager.getPage(request.browser, request.page);
        const started = await videoRecordings.start({
          browser: request.browser,
          page: request.page,
          pageObject: page,
          file: request.file,
          size: request.size,
          maxDurationSeconds: request.maxDurationSeconds,
          connected: manager.getBrowser(request.browser)?.type === "connected",
        });
        data = { action: "start", browser: request.browser, page: request.page, ...started };
      } else if (request.action === "chapter") {
        const chapter = await videoRecordings.chapter({
          browser: request.browser,
          page: request.page,
          title: request.title,
          description: request.description,
          durationMs: request.durationMs,
        });
        data = { action: "chapter", browser: request.browser, page: request.page, ...chapter };
      } else {
        const stopped = await videoRecordings.stop({
          browser: request.browser,
          page: request.page,
        });
        data = { action: "stop", browser: request.browser, page: request.page, ...stopped };
      }

      await writeMessage(socket, { id: request.id, type: "result", data });
      await writeMessage(socket, { id: request.id, type: "complete", success: true });
    } catch (error) {
      const failure = buildInteractiveFailure({
        requestId: request.id,
        browser: request.browser,
        page: request.page,
        action: `video-${request.action}`,
        error,
      });
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: failure.error.message,
        exitCode: agentErrorExitCode(failure.error.code),
        error: failure.error,
        data: failure,
      });
    }
  });
}

async function handleTrace(socket: net.Socket, request: TraceRequest): Promise<void> {
  try {
    const data = await traceStore.read(request.traceId);
    await writeMessage(socket, { id: request.id, type: "result", data });
    await writeMessage(socket, { id: request.id, type: "complete", success: true });
  } catch (error) {
    await writeMessage(socket, {
      id: request.id,
      type: "error",
      message: redactSensitive(formatError(error)) as string,
      exitCode: 2,
    });
  }
}

async function handleInstall(socket: net.Socket, request: { id: string }): Promise<void> {
  await withInstallLock(async () => {
    const output = createMessageQueue(socket);
    try {
      await mkdir(BASE_DIR, { recursive: true });
      await writeFile(path.join(BASE_DIR, "package.json"), EMBEDDED_PACKAGE_JSON);
      const npmProgram = process.platform === "win32" ? "npm.cmd" : "npm";
      await runInstallCommand(output, request.id, npmProgram, ["install"], BASE_DIR, "npm install");
      await runInstallCommand(
        output,
        request.id,
        npmProgram,
        ["exec", "--", "playwright", "install", "chromium"],
        BASE_DIR,
        "Playwright install"
      );
      await writeMessage(socket, {
        id: request.id,
        type: "complete",
        success: true,
      });
    } catch (error) {
      await output.drain().catch(() => undefined);
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: formatError(error),
      });
    }
  });
}

async function runInstallCommand(
  output: ReturnType<typeof createMessageQueue>,
  requestId: string,
  program: string,
  args: string[],
  cwd: string,
  label: string
): Promise<void> {
  const child = spawn(program, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => {
    void output.push({
      id: requestId,
      type: "stdout",
      data,
    });
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    void output.push({
      id: requestId,
      type: "stderr",
      data,
    });
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }
  );

  await output.drain();

  if (result.code === 0) {
    return;
  }

  const reason =
    result.signal !== null
      ? `${label} terminated by signal ${result.signal}`
      : `${label} failed with exit code ${result.code ?? "unknown"}`;

  throw new Error(reason);
}

async function handleRequest(socket: net.Socket, line: string): Promise<void> {
  const parsed = parseRequest(line);
  if (!parsed.success) {
    if (parsed.agentError) {
      const failure = buildInteractiveFailure({
        requestId: parsed.id ?? "unknown",
        error: parsed.agentError,
      });
      await writeMessage(socket, {
        id: parsed.id ?? "unknown",
        type: "error",
        message: failure.error.message,
        exitCode: agentErrorExitCode(failure.error.code),
        error: failure.error,
        data: failure,
      });
      return;
    }
    await writeMessage(socket, {
      id: parsed.id ?? "unknown",
      type: "error",
      message: parsed.error,
    });
    return;
  }

  const { request } = parsed;

  if (shuttingDown && request.type !== "stop") {
    await writeMessage(socket, {
      id: request.id,
      type: "error",
      message: "Daemon is shutting down",
    });
    return;
  }

  if (request.type === "handshake") {
    await handleHandshake(socket, request);
    return;
  }

  if (request.type === "restart") {
    await handleRestart(socket, request);
    return;
  }

  const tracksOperation = [
    "execute",
    "interactive",
    "session",
    "install",
    "browser-stop",
    "video",
  ].includes(request.type);
  let finishOperation: (() => void) | undefined;
  if (tracksOperation) {
    try {
      finishOperation = operations.begin();
    } catch {
      const error = new AgentProtocolError(
        "DAEMON_VERSION_MISMATCH",
        "Daemon restart is pending; retry after the daemon becomes available",
        true,
        { nextCommands: ["dev-browser status"] }
      );
      await writeMessage(socket, {
        id: request.id,
        type: "error",
        message: error.message,
        exitCode: agentErrorExitCode(error.code),
        error: error.toAgentError(),
      });
      return;
    }
  }

  try {
    switch (request.type) {
      case "execute":
        await handleExecute(socket, request);
        return;

      case "interactive":
        await handleInteractive(socket, request);
        return;

      case "session":
        await handleSession(socket, request);
        return;

      case "trace":
        await handleTrace(socket, request);
        return;

      case "video":
        await handleVideo(socket, request);
        return;

      case "browsers":
        await writeMessage(socket, {
          id: request.id,
          type: "result",
          data: manager.listBrowsers(),
        });
        await writeMessage(socket, {
          id: request.id,
          type: "complete",
          success: true,
        });
        return;

      case "browser-stop":
        // A recording cannot be salvaged once its browser is gone, so it is
        // finalized while the browser is still connected.
        await videoRecordings.finalizeAll(request.browser);
        await manager.stopBrowser(request.browser);
        await writeMessage(socket, {
          id: request.id,
          type: "result",
          data: { browser: request.browser, stopped: true },
        });
        await writeMessage(socket, {
          id: request.id,
          type: "complete",
          success: true,
        });
        return;

      case "status":
        await writeMessage(socket, {
          id: request.id,
          type: "result",
          data: {
            pid: process.pid,
            uptimeMs: Date.now() - startedAt,
            browserCount: manager.browserCount(),
            browsers: manager.listBrowsers(),
            socketPath: SOCKET_PATH,
          },
        });
        await writeMessage(socket, {
          id: request.id,
          type: "complete",
          success: true,
        });
        return;

      case "install":
        await handleInstall(socket, request);
        return;

      case "stop":
        await writeMessage(socket, {
          id: request.id,
          type: "result",
          data: { stopping: true },
        });
        await writeMessage(socket, {
          id: request.id,
          type: "complete",
          success: true,
        });
        void shutdown(0);
        return;
    }
  } finally {
    finishOperation?.();
  }
}

async function handleHandshake(socket: net.Socket, request: HandshakeRequest): Promise<void> {
  const data = await buildRuntimeHandshake({
    cliVersion: request.cliVersion,
    cliBuildHash: request.cliBuildHash,
    embeddedDaemonHash: request.embeddedDaemonHash,
    expectedDaemonHash: request.expectedDaemonHash,
  });
  await writeMessage(socket, {
    id: request.id,
    type: "result",
    data: { ...data, activeOperations: operations.activeOperations },
  });
  await writeMessage(socket, { id: request.id, type: "complete", success: true });
}

async function handleRestart(socket: net.Socket, request: RestartRequest): Promise<void> {
  const processHash = await currentProcessHash();
  const reservation =
    request.currentDaemonHash === processHash
      ? operations.reserveIdleRestart()
      : { ok: false, activeOperations: operations.activeOperations };
  if (!reservation.ok) {
    const error = new AgentProtocolError(
      "DAEMON_VERSION_MISMATCH",
      reservation.activeOperations > 0
        ? `Daemon runtime mismatch cannot restart while ${reservation.activeOperations} operation(s) are active`
        : "Daemon runtime changed during restart coordination; retry the command",
      true,
      {
        details: { activeOperations: reservation.activeOperations },
        nextCommands: ["dev-browser status"],
      }
    );
    await writeMessage(socket, {
      id: request.id,
      type: "error",
      message: error.message,
      exitCode: agentErrorExitCode(error.code),
      error: error.toAgentError(),
    });
    return;
  }
  await writeMessage(socket, {
    id: request.id,
    type: "result",
    data: { restarting: true, processHash },
  });
  await writeMessage(socket, { id: request.id, type: "complete", success: true });
  void shutdown(0);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    const serverToClose = server;
    server = null;
    const serverClosed = serverToClose ? closeServerInstance(serverToClose) : Promise.resolve();

    // Finalize before the browsers go away: a shutdown must never leave a
    // half-written recording behind.
    await videoRecordings.finalizeAll();
    await manager.stopAll();
    await Promise.allSettled(Array.from(clients, (socket) => closeClientSocket(socket)));
    await serverClosed;
    const cleanup = [unlinkIfExists(PID_PATH)];
    if (requiresDaemonEndpointCleanup()) {
      cleanup.push(unlinkIfExists(SOCKET_PATH));
    }
    await Promise.allSettled(cleanup);

    clients.clear();

    process.exit(exitCode);
  })();

  return shuttingDown;
}

async function start(): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await ensureDevBrowserTempDir();
  if (requiresDaemonEndpointCleanup()) {
    await unlinkIfExists(SOCKET_PATH);
  }
  await writeFile(PID_PATH, `${process.pid}\n`);

  server = net.createServer((socket) => {
    if (shuttingDown) {
      socket.end();
      return;
    }

    clients.add(socket);
    socket.setEncoding("utf8");

    let buffer = "";
    let queue = Promise.resolve();

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        queue = queue
          .then(() => handleRequest(socket, line))
          .catch(async (error) => {
            console.error("Request handling error:", error);
            if (!socket.destroyed) {
              await writeMessage(socket, {
                id: "unknown",
                type: "error",
                message: formatError(error),
              });
            }
          });
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", () => {
      clients.delete(socket);
    });
  });

  server.on("error", (error) => {
    console.error("Daemon server error:", error);
    void shutdown(1);
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(SOCKET_PATH, () => {
      server?.off("error", reject);
      resolve();
    });
  });

  process.stderr.write("daemon ready\n");
}

function registerShutdownHandlers(): void {
  const handleSignal = () => {
    void shutdown(0);
  };

  const handleFatalError = (error: unknown) => {
    console.error("Fatal daemon error:", error);
    void shutdown(1);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("SIGHUP", handleSignal);
  process.on("uncaughtException", handleFatalError);
  process.on("unhandledRejection", handleFatalError);
}

registerShutdownHandlers();

start().catch((error) => {
  console.error("Failed to start daemon:", error);
  void shutdown(1);
});
