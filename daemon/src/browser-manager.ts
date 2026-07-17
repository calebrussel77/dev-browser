import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  SelectiveCdpTransport,
  type CdpPageTarget,
} from "./selective-cdp-transport.js";

type SelectiveCdpTransportLike = Pick<
  SelectiveCdpTransport,
  | "attachToTarget"
  | "close"
  | "detachFromTarget"
  | "listPageTargets"
  | "onclose"
  | "onmessage"
  | "send"
>;

export interface BrowserEntry {
  name: string;
  type: "launched" | "connected";
  browser: Browser;
  context: BrowserContext;
  pages: Map<string, Page>;
  profileDir?: string;
  endpoint?: string;
  headless: boolean;
  ignoreHTTPSErrors: boolean;
  selectiveTransport?: SelectiveCdpTransportLike;
  targetAttachTimeoutMs?: number;
}

interface BrowserSummary {
  name: string;
  type: BrowserEntry["type"];
  status: "running" | "connected" | "disconnected";
  pages: string[];
}

interface BrowserPageSummary {
  id: string;
  url: string;
  title: string;
  name: string | null;
}

type BrowserManagerDependencies = {
  connectOverCDP: typeof chromium.connectOverCDP;
  createSelectiveCdpTransport: (
    endpoint: string,
    timeoutMs: number
  ) => Promise<SelectiveCdpTransportLike>;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  homedir: () => string;
  launchPersistentContext: typeof chromium.launchPersistentContext;
  mkdir: typeof mkdir;
  platform: NodeJS.Platform;
  readFile: typeof readFile;
  webSocket: typeof globalThis.WebSocket | null;
};

type DebuggerWebSocketLookupResult =
  | {
      status: "ok";
      webSocketDebuggerUrl: string;
    }
  | {
      status: "not-found" | "unavailable";
    };

type ConnectBrowserOptions = {
  connectTimeoutMs?: number;
};

type CdpPreflightResult =
  | {
      status: "ok";
      product: string;
      targetCount: number;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
    };

const DISCOVERY_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];
const CHROMIUM_ATTACH_TO_OTHER_ENV = "PW_CHROMIUM_ATTACH_TO_OTHER";
const CDP_PREFLIGHT_ENV = "DEV_BROWSER_CDP_PREFLIGHT";
const PROBE_TIMEOUT_MS = 750;
const MANUAL_CONNECT_TIMEOUT_MS = 5_000;
const CDP_PREFLIGHT_TIMEOUT_MS = 5_000;
const PAGE_TITLE_TIMEOUT_MS = 1_500;
const SELECTIVE_TARGET_ATTACH_TIMEOUT_MS = 15_000;
const SELECTIVE_TARGET_REUSE_TIMEOUT_MS = 5_000;
const TARGET_ID_PATTERN = /^[a-f0-9]{16,}$/i;

function isIgnorableFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES";
}

function isHttpEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("http://") || endpoint.startsWith("https://");
}

function isWebSocketEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("ws://") || endpoint.startsWith("wss://");
}

export class BrowserManager {
  private readonly browsers = new Map<string, BrowserEntry>();
  private readonly baseDir: string;
  private readonly dependencies: BrowserManagerDependencies;
  private readonly supportsSelectiveTransport: boolean;

  constructor(
    baseDir = path.join(os.homedir(), ".dev-browser", "browsers"),
    dependencies: Partial<BrowserManagerDependencies> = {}
  ) {
    this.baseDir = baseDir;
    const webSocket =
      dependencies.webSocket === undefined
        ? typeof globalThis.WebSocket === "function"
          ? globalThis.WebSocket
          : null
        : dependencies.webSocket;
    this.supportsSelectiveTransport =
      webSocket !== null || dependencies.createSelectiveCdpTransport !== undefined;
    this.dependencies = {
      connectOverCDP: chromium.connectOverCDP.bind(chromium) as typeof chromium.connectOverCDP,
      createSelectiveCdpTransport: async (endpoint, timeoutMs) => {
        if (!webSocket) {
          throw new Error("WebSocket is not available in this Node.js runtime");
        }
        return SelectiveCdpTransport.connect(endpoint, {
          timeoutMs,
          webSocket,
        });
      },
      env: process.env,
      fetch: globalThis.fetch,
      homedir: os.homedir,
      launchPersistentContext: chromium.launchPersistentContext.bind(
        chromium
      ) as typeof chromium.launchPersistentContext,
      mkdir,
      platform: process.platform,
      readFile,
      webSocket,
      ...dependencies,
    };
  }

  async ensureBrowser(
    name: string,
    options: {
      headless?: boolean;
      ignoreHTTPSErrors?: boolean;
    } = {}
  ): Promise<BrowserEntry> {
    await this.ensureBaseDir();
    const existing = this.browsers.get(name);
    const requestedHeadless = options.headless ?? existing?.headless ?? false;
    const requestedIgnoreHTTPSErrors =
      options.ignoreHTTPSErrors ?? existing?.ignoreHTTPSErrors ?? false;

    if (existing) {
      const needsRelaunch =
        existing.type !== "launched" ||
        !existing.browser.isConnected() ||
        (options.headless !== undefined && existing.headless !== requestedHeadless) ||
        (options.ignoreHTTPSErrors !== undefined &&
          existing.ignoreHTTPSErrors !== requestedIgnoreHTTPSErrors);

      if (!needsRelaunch) {
        return existing;
      }

      await this.stopBrowser(name);
    }

    return this.launchBrowser(name, requestedHeadless, requestedIgnoreHTTPSErrors);
  }

  async autoConnect(name: string, options: ConnectBrowserOptions = {}): Promise<BrowserEntry> {
    await this.ensureBaseDir();

    const existing = this.browsers.get(name);
    if (existing?.type === "connected" && existing.browser.isConnected()) {
      return existing;
    }

    if (existing) {
      await this.stopBrowser(name);
    }

    const attemptedEndpoints = new Set<string>();
    let lastError: unknown;

    const tryEndpoint = async (endpoint: string | null): Promise<BrowserEntry | null> => {
      if (!endpoint || attemptedEndpoints.has(endpoint)) {
        return null;
      }

      attemptedEndpoints.add(endpoint);

      try {
        return await this.openConnectedBrowser(name, endpoint, options);
      } catch (error) {
        lastError = error;
        return null;
      }
    };

    const devToolsEndpoint = await this.readDevToolsActivePort();
    const devToolsBrowser = await tryEndpoint(devToolsEndpoint);
    if (devToolsBrowser) {
      return devToolsBrowser;
    }

    for (const port of DISCOVERY_PORTS) {
      const endpoint = await this.probePort(port);
      const connectedBrowser = await tryEndpoint(endpoint);
      if (connectedBrowser) {
        return connectedBrowser;
      }
    }

    throw new Error(this.buildAutoConnectError(lastError));
  }

  async connectBrowser(
    name: string,
    endpoint: string,
    options: ConnectBrowserOptions = {}
  ): Promise<BrowserEntry> {
    if (endpoint === "auto") {
      return this.autoConnect(name, options);
    }

    await this.ensureBaseDir();
    const resolvedEndpoint = await this.resolveEndpoint(endpoint);

    const existing = this.browsers.get(name);
    if (existing) {
      const isSameConnection =
        existing.type === "connected" &&
        existing.endpoint === resolvedEndpoint &&
        existing.browser.isConnected();

      if (isSameConnection) {
        return existing;
      }

      await this.stopBrowser(name);
    }

    return this.openConnectedBrowser(name, resolvedEndpoint, options);
  }

  getBrowser(name: string): BrowserEntry | undefined {
    const entry = this.browsers.get(name);
    if (!entry || !entry.browser.isConnected()) {
      return undefined;
    }

    return entry;
  }

  async getPage(browserName: string, pageNameOrId: string): Promise<Page> {
    const entry = this.getBrowserEntry(browserName);
    const existingPage = entry.pages.get(pageNameOrId);

    if (existingPage && !existingPage.isClosed()) {
      return existingPage;
    }

    entry.pages.delete(pageNameOrId);

    if (TARGET_ID_PATTERN.test(pageNameOrId)) {
      let page = await this.findPageByTargetId(entry, pageNameOrId);
      if (page) {
        return page;
      }

      if (entry.selectiveTransport) {
        const rawTarget = (await entry.selectiveTransport.listPageTargets()).find(
          (target) => target.id === pageNameOrId
        );
        await entry.selectiveTransport.attachToTarget(pageNameOrId);
        const attachTimeoutMs =
          entry.targetAttachTimeoutMs ?? SELECTIVE_TARGET_ATTACH_TIMEOUT_MS;
        page = await this.waitForPageByTargetId(
          entry,
          pageNameOrId,
          Math.min(attachTimeoutMs, SELECTIVE_TARGET_REUSE_TIMEOUT_MS)
        );
        if (page) {
          return page;
        }

        await entry.selectiveTransport.detachFromTarget(pageNameOrId).catch(() => undefined);
        if (!rawTarget) {
          throw new Error(`Chrome target "${pageNameOrId}" no longer exists`);
        }

        const fallbackPage = await entry.context.newPage();
        this.registerNamedPage(entry, pageNameOrId, fallbackPage);
        if (rawTarget.url && rawTarget.url !== "about:blank") {
          await fallbackPage.goto(rawTarget.url, {
            timeout: attachTimeoutMs,
            waitUntil: "domcontentloaded",
          });
        }
        return fallbackPage;
      }
    }

    const page = await entry.context.newPage();
    this.registerNamedPage(entry, pageNameOrId, page);
    return page;
  }

  async newPage(browserName: string): Promise<Page> {
    const entry = this.getBrowserEntry(browserName);
    return entry.context.newPage();
  }

  async registerPageTarget(browserName: string, page: Page): Promise<string> {
    const entry = this.getBrowserEntry(browserName);
    if (page.isClosed()) throw new Error("Popup page closed before registration");
    const targetId = await this.getPageTargetId(page.context(), page);
    if (!targetId) throw new Error("Popup target id is unavailable");
    this.registerNamedPage(entry, targetId, page);
    return targetId;
  }

  registerKnownPageTarget(browserName: string, targetId: string, page: Page): void {
    if (!TARGET_ID_PATTERN.test(targetId)) throw new Error("Popup target id is invalid");
    const entry = this.getBrowserEntry(browserName);
    if (page.isClosed()) throw new Error("Popup page closed before registration");
    this.registerNamedPage(entry, targetId, page);
  }

  isNamedPage(browserName: string, pageName: string, page: Page): boolean {
    return this.getBrowserEntry(browserName).pages.get(pageName) === page;
  }

  async listPages(browserName: string): Promise<BrowserPageSummary[]> {
    const entry = this.browsers.get(browserName);
    if (!entry || !entry.browser.isConnected()) {
      return [];
    }

    this.pruneClosedPages(entry);
    const namesByPage = this.getNamedPagesByPage(entry);
    const summaries = new Map<string, BrowserPageSummary>();

    if (entry.selectiveTransport) {
      const targets = await entry.selectiveTransport.listPageTargets();
      for (const target of targets) {
        summaries.set(target.id, this.summarizeRawTarget(target));
      }
    }

    for (const { context, page } of this.getContextPages(entry)) {
      const id = await this.getPageTargetId(context, page);
      if (!id) {
        continue;
      }

      let title = "";
      try {
        title = await this.getPageTitle(page);
      } catch (error) {
        if (page.isClosed()) {
          continue;
        }

        throw error;
      }

      summaries.set(id, {
        id,
        url: page.url(),
        title,
        name: namesByPage.get(page) ?? null,
      });
    }

    return Array.from(summaries.values());
  }

  async closePage(browserName: string, pageName: string): Promise<void> {
    const entry = this.getBrowserEntry(browserName);
    const page = entry.pages.get(pageName);

    if (!page || page.isClosed()) {
      entry.pages.delete(pageName);
      throw new Error(`Page "${browserName}/${pageName}" not found`);
    }

    entry.pages.delete(pageName);

    if (!page.isClosed()) {
      await page.close();
    }
  }

  listBrowsers(): BrowserSummary[] {
    return Array.from(this.browsers.values())
      .map((entry) => {
        this.pruneClosedPages(entry);

        const status: BrowserSummary["status"] =
          entry.type === "connected"
            ? entry.browser.isConnected()
              ? "connected"
              : "disconnected"
            : entry.browser.isConnected()
              ? "running"
              : "disconnected";

        return {
          name: entry.name,
          type: entry.type,
          status,
          pages: this.listNamedPages(entry),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async stopBrowser(name: string): Promise<void> {
    const entry = this.browsers.get(name);
    if (!entry) {
      return;
    }

    this.browsers.delete(name);
    entry.pages.clear();

    try {
      if (entry.type === "launched") {
        await this.closeLaunchedBrowser(entry);
      } else {
        await entry.browser.close();
      }
    } catch {
      // Best effort during shutdown or reconnect.
    }
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.browsers.keys());
    await Promise.allSettled(names.map(async (name) => this.stopBrowser(name)));
  }

  browserCount(): number {
    return this.browsers.size;
  }

  private async ensureBaseDir(): Promise<void> {
    await this.dependencies.mkdir(this.baseDir, { recursive: true });
  }

  private getBrowserEntry(name: string): BrowserEntry {
    const entry = this.browsers.get(name);
    if (!entry || !entry.browser.isConnected()) {
      throw new Error(`Browser "${name}" is not running`);
    }

    return entry;
  }

  private async launchBrowser(
    name: string,
    headless: boolean,
    ignoreHTTPSErrors: boolean
  ): Promise<BrowserEntry> {
    const profileDir = path.join(this.baseDir, name, "chromium-profile");
    await this.dependencies.mkdir(profileDir, { recursive: true });

    const context = await this.dependencies.launchPersistentContext(profileDir, {
      headless,
      viewport: headless ? undefined : null,
      ignoreHTTPSErrors,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const browser = context.browser();

    if (!browser) {
      await context.close();
      throw new Error(`Playwright did not expose a browser handle for "${name}"`);
    }

    const entry: BrowserEntry = {
      name,
      type: "launched",
      browser,
      context,
      pages: new Map(),
      profileDir,
      headless,
      ignoreHTTPSErrors,
    };

    this.attachBrowserLifecycle(entry);
    this.browsers.set(name, entry);
    return entry;
  }

  private async openConnectedBrowser(
    name: string,
    endpoint: string,
    options: ConnectBrowserOptions = {}
  ): Promise<BrowserEntry> {
    const preflight = await this.preflightCdpEndpoint(endpoint, options.connectTimeoutMs);
    let browser: Browser;
    let selectiveTransport: SelectiveCdpTransportLike | undefined;

    try {
      if (
        options.connectTimeoutMs !== undefined &&
        isWebSocketEndpoint(endpoint) &&
        this.supportsSelectiveTransport
      ) {
        selectiveTransport = await this.dependencies.createSelectiveCdpTransport(
          endpoint,
          options.connectTimeoutMs
        );
        browser = await this.dependencies.connectOverCDP(selectiveTransport, {
          noDefaults: true,
          timeout: options.connectTimeoutMs,
        });
      } else {
        this.enableChromiumAttachToOtherTargets();
        browser =
          options.connectTimeoutMs === undefined
            ? await this.dependencies.connectOverCDP(endpoint)
            : await this.dependencies.connectOverCDP(endpoint, {
                timeout: options.connectTimeoutMs,
              });
      }
    } catch (error) {
      selectiveTransport?.close();
      throw this.buildConnectOverCdpError(endpoint, error, preflight);
    }

    const contexts = browser.contexts();

    // Enumerate existing tabs for connected browsers, but leave them unnamed so getPage(name)
    // still opens a fresh tab unless a targetId is provided.
    for (const browserContext of contexts) {
      browserContext.pages();
    }

    const context = contexts[0] ?? (await browser.newContext());

    const entry: BrowserEntry = {
      name,
      type: "connected",
      browser,
      context,
      pages: new Map(),
      endpoint,
      headless: false,
      ignoreHTTPSErrors: false,
      selectiveTransport,
      targetAttachTimeoutMs: options.connectTimeoutMs,
    };

    this.attachBrowserLifecycle(entry);
    this.browsers.set(name, entry);
    return entry;
  }

  private enableChromiumAttachToOtherTargets(): void {
    this.dependencies.env[CHROMIUM_ATTACH_TO_OTHER_ENV] = "1";
  }

  private async preflightCdpEndpoint(
    endpoint: string,
    connectTimeoutMs?: number
  ): Promise<CdpPreflightResult> {
    if (this.dependencies.env[CDP_PREFLIGHT_ENV] === "0") {
      return {
        status: "skipped",
        reason: `${CDP_PREFLIGHT_ENV}=0 disables raw CDP diagnostics`,
      };
    }

    if (connectTimeoutMs === undefined) {
      return {
        status: "skipped",
        reason: "no connection timeout was provided",
      };
    }

    if (!isWebSocketEndpoint(endpoint)) {
      return {
        status: "skipped",
        reason: "endpoint is not a WebSocket URL",
      };
    }

    const WebSocketImpl = this.dependencies.webSocket;
    if (!WebSocketImpl) {
      return {
        status: "skipped",
        reason: "WebSocket is not available in this Node.js runtime",
      };
    }

    const timeoutMs = Math.min(connectTimeoutMs, CDP_PREFLIGHT_TIMEOUT_MS);

    try {
      return await new Promise<CdpPreflightResult>((resolve, reject) => {
        let settled = false;
        let product = "";
        let socket: WebSocket | undefined;

        const timeout = setTimeout(() => {
          fail(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timeout);
          try {
            if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
              socket.close();
            }
          } catch {
            // Best effort after a diagnostic probe.
          }
        };

        const succeed = (result: CdpPreflightResult) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(result);
        };

        const fail = (error: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          reject(error);
        };

        try {
          socket = new WebSocketImpl(endpoint);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        socket.addEventListener("open", () => {
          try {
            socket?.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });

        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            fail(new Error("received a non-text CDP response"));
            return;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(event.data);
          } catch {
            fail(new Error("received invalid JSON from the CDP WebSocket"));
            return;
          }

          if (!payload || typeof payload !== "object" || !("id" in payload)) {
            return;
          }

          const message = payload as {
            id?: unknown;
            error?: unknown;
            result?: unknown;
          };

          if (message.error) {
            fail(new Error(`CDP command failed: ${JSON.stringify(message.error)}`));
            return;
          }

          if (message.id === 1) {
            try {
              product = this.extractCdpProduct(message.result);
              socket?.send(JSON.stringify({ id: 2, method: "Target.getTargets" }));
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }

          if (message.id === 2) {
            try {
              const targetCount = this.extractCdpTargetCount(message.result);
              succeed({
                status: "ok",
                product,
                targetCount,
              });
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          }
        });

        socket.addEventListener("error", () => {
          fail(new Error("WebSocket error before CDP preflight completed"));
        });

        socket.addEventListener("close", () => {
          fail(new Error("WebSocket closed before CDP preflight completed"));
        });
      });
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private extractCdpProduct(result: unknown): string {
    if (!result || typeof result !== "object") {
      throw new Error("Browser.getVersion returned no result");
    }

    const product = (result as { product?: unknown }).product;
    return typeof product === "string" && product.length > 0 ? product : "unknown Chrome";
  }

  private extractCdpTargetCount(result: unknown): number {
    if (!result || typeof result !== "object") {
      throw new Error("Target.getTargets returned no result");
    }

    const targetInfos = (result as { targetInfos?: unknown }).targetInfos;
    if (!Array.isArray(targetInfos)) {
      throw new Error("Target.getTargets did not return a target list");
    }

    return targetInfos.length;
  }

  private buildConnectOverCdpError(
    endpoint: string,
    error: unknown,
    preflight: CdpPreflightResult
  ): Error {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const details = [`Could not attach to Chrome via Playwright CDP at ${endpoint}.`];

    if (preflight.status === "ok") {
      details.push(
        `Raw CDP preflight succeeded (${preflight.product}, ${preflight.targetCount} targets), so Chrome is reachable but Playwright could not finish attaching.`
      );
    } else if (preflight.status === "skipped") {
      details.push(`Raw CDP preflight was skipped: ${preflight.reason}.`);
    } else {
      details.push(`Raw CDP preflight failed: ${preflight.reason}.`);
    }

    details.push(
      "Use `--timeout SECONDS` to control the Playwright attach timeout.",
      "If `/json/version` returns 404, prefer `dev-browser --connect` without a URL so DevToolsActivePort can be used, or pass the exact ws://... endpoint from DevToolsActivePort.",
      "If the daemon was already running before a fix or environment change, run `dev-browser stop` and retry.",
      `Original error: ${errorMessage}`
    );

    return new Error(details.join("\n"));
  }

  private attachBrowserLifecycle(entry: BrowserEntry): void {
    entry.browser.on("disconnected", () => {
      const current = this.browsers.get(entry.name);
      if (current !== entry) {
        return;
      }

      entry.pages.clear();

      if (entry.type === "launched") {
        this.browsers.delete(entry.name);
      }
    });
  }

  private async closeLaunchedBrowser(entry: BrowserEntry): Promise<void> {
    const contexts = this.getBrowserContexts(entry);
    await Promise.allSettled(contexts.map(async (context) => context.close()));

    if (entry.browser.isConnected()) {
      await entry.browser.close().catch(() => undefined);
    }
  }

  private async discoverChrome(): Promise<string | null> {
    const devToolsEndpoint = await this.readDevToolsActivePort();
    if (devToolsEndpoint) {
      return devToolsEndpoint;
    }

    for (const port of DISCOVERY_PORTS) {
      const endpoint = await this.probePort(port);
      if (endpoint) {
        return endpoint;
      }
    }

    return null;
  }

  private async readDevToolsActivePort(expectedPort?: number): Promise<string | null> {
    for (const candidate of this.getDevToolsActivePortCandidates()) {
      let contents: string;

      try {
        contents = await this.dependencies.readFile(candidate, "utf8");
      } catch (error) {
        if (isIgnorableFileError(error)) {
          continue;
        }

        throw error;
      }

      const endpoint = this.parseDevToolsActivePort(contents, expectedPort);
      if (endpoint) {
        return endpoint;
      }
    }

    return null;
  }

  private async probePort(port: number): Promise<string | null> {
    const endpoint = `http://127.0.0.1:${port}`;
    const result = await this.fetchDebuggerWebSocketUrl(endpoint, PROBE_TIMEOUT_MS);

    if (result.status === "ok") {
      return result.webSocketDebuggerUrl;
    }

    if (result.status === "not-found") {
      return this.readDevToolsActivePort(port);
    }

    return null;
  }

  private getDevToolsActivePortCandidates(): string[] {
    const homeDir = this.dependencies.homedir();

    switch (this.dependencies.platform) {
      case "darwin":
        return [
          path.join(
            homeDir,
            "Library",
            "Application Support",
            "Google",
            "Chrome",
            "DevToolsActivePort"
          ),
          path.join(
            homeDir,
            "Library",
            "Application Support",
            "Google",
            "Chrome Canary",
            "DevToolsActivePort"
          ),
          path.join(homeDir, "Library", "Application Support", "Chromium", "DevToolsActivePort"),
          path.join(
            homeDir,
            "Library",
            "Application Support",
            "BraveSoftware",
            "Brave-Browser",
            "DevToolsActivePort"
          ),
        ];
      case "linux":
        return [
          path.join(homeDir, ".config", "google-chrome", "DevToolsActivePort"),
          path.join(homeDir, ".config", "chromium", "DevToolsActivePort"),
          path.join(homeDir, ".config", "google-chrome-beta", "DevToolsActivePort"),
          path.join(homeDir, ".config", "google-chrome-unstable", "DevToolsActivePort"),
          path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser", "DevToolsActivePort"),
        ];
      case "win32":
        return [
          path.join(
            homeDir,
            "AppData",
            "Local",
            "Google",
            "Chrome",
            "User Data",
            "DevToolsActivePort"
          ),
          path.join(
            homeDir,
            "AppData",
            "Local",
            "Google",
            "Chrome Beta",
            "User Data",
            "DevToolsActivePort"
          ),
          path.join(
            homeDir,
            "AppData",
            "Local",
            "Google",
            "Chrome SxS",
            "User Data",
            "DevToolsActivePort"
          ),
          path.join(homeDir, "AppData", "Local", "Chromium", "User Data", "DevToolsActivePort"),
          path.join(
            homeDir,
            "AppData",
            "Local",
            "BraveSoftware",
            "Brave-Browser",
            "User Data",
            "DevToolsActivePort"
          ),
        ];
      default:
        return [];
    }
  }

  private async resolveEndpoint(endpoint: string): Promise<string> {
    if (endpoint === "auto") {
      const discoveredEndpoint = await this.discoverChrome();
      if (discoveredEndpoint) {
        return discoveredEndpoint;
      }

      throw new Error(this.buildAutoConnectError());
    }

    if (isHttpEndpoint(endpoint)) {
      const discoveredEndpoint = await this.resolveHttpEndpoint(
        endpoint,
        MANUAL_CONNECT_TIMEOUT_MS
      );

      if (!discoveredEndpoint) {
        throw new Error(this.buildManualConnectError(endpoint));
      }

      return discoveredEndpoint;
    }

    return endpoint;
  }

  private async fetchDebuggerWebSocketUrl(
    endpoint: string,
    timeoutMs: number
  ): Promise<DebuggerWebSocketLookupResult> {
    let response: Response;

    try {
      response = await this.dependencies.fetch(this.toJsonVersionUrl(endpoint), {
        headers: {
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: "unavailable" };
    }

    if (response.status === 404) {
      return { status: "not-found" };
    }

    if (!response.ok) {
      return { status: "unavailable" };
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      return { status: "unavailable" };
    }

    const webSocketDebuggerUrl =
      typeof payload === "object" && payload !== null
        ? (payload as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
        : undefined;

    return typeof webSocketDebuggerUrl === "string" && webSocketDebuggerUrl.length > 0
      ? {
          status: "ok",
          webSocketDebuggerUrl,
        }
      : { status: "unavailable" };
  }

  private toJsonVersionUrl(endpoint: string): URL {
    const url = new URL(endpoint);
    if (url.pathname !== "/json/version") {
      url.pathname = "/json/version";
      url.search = "";
      url.hash = "";
    }

    return url;
  }

  private buildAutoConnectError(lastError?: unknown): string {
    const launchCommand =
      this.dependencies.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222"
        : this.dependencies.platform === "win32"
          ? "chrome.exe --remote-debugging-port=9222"
          : "google-chrome --remote-debugging-port=9222";

    const lastErrorMessage =
      lastError instanceof Error
        ? lastError.message
        : typeof lastError === "string" && lastError.length > 0
          ? lastError
          : null;

    if (lastErrorMessage) {
      return [
        "Chrome's CDP endpoint was discovered, but dev-browser could not attach to it.",
        `Last connection error: ${lastErrorMessage}`,
      ].join("\n");
    }

    return [
      "Could not auto-discover a running Chrome instance with remote debugging enabled.",
      "Enable Chrome remote debugging at chrome://inspect/#remote-debugging",
      `or launch Chrome with: ${launchCommand}`,
    ].join("\n");
  }

  private async resolveHttpEndpoint(endpoint: string, timeoutMs: number): Promise<string | null> {
    const result = await this.fetchDebuggerWebSocketUrl(endpoint, timeoutMs);
    if (result.status === "ok") {
      return result.webSocketDebuggerUrl;
    }

    if (result.status === "not-found") {
      const port = this.getEndpointPort(endpoint);
      if (port !== null) {
        return this.readDevToolsActivePort(port);
      }
    }

    return null;
  }

  private parseDevToolsActivePort(contents: string, expectedPort?: number): string | null {
    const lines = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const port = Number.parseInt(lines[0] ?? "", 10);
    const webSocketPath = lines[1] ?? "";

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }

    if (expectedPort !== undefined && port !== expectedPort) {
      return null;
    }

    if (!webSocketPath.startsWith("/devtools/browser/")) {
      return null;
    }

    return `ws://127.0.0.1:${port}${webSocketPath}`;
  }

  private getEndpointPort(endpoint: string): number | null {
    let url: URL;

    try {
      url = new URL(endpoint);
    } catch {
      return null;
    }

    const rawPort =
      url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    const port = Number.parseInt(rawPort, 10);

    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  }

  private buildManualConnectError(endpoint: string): string {
    return [
      `Could not resolve a CDP WebSocket endpoint from ${endpoint}.`,
      "If Chrome is using built-in remote debugging, run `dev-browser --connect` without a URL so DevToolsActivePort can be auto-discovered.",
      "Or connect with the exact ws://127.0.0.1:<port>/devtools/browser/... URL from DevToolsActivePort, or launch Chrome with --remote-debugging-port=9222.",
    ].join("\n");
  }

  private registerNamedPage(entry: BrowserEntry, pageName: string, page: Page): void {
    entry.pages.set(pageName, page);

    page.on("close", () => {
      const current = entry.pages.get(pageName);
      if (current === page) {
        entry.pages.delete(pageName);
      }
    });
  }

  private pruneClosedPages(entry: BrowserEntry): void {
    for (const [pageName, page] of entry.pages.entries()) {
      if (page.isClosed()) {
        entry.pages.delete(pageName);
      }
    }
  }

  private listNamedPages(entry: BrowserEntry): string[] {
    this.pruneClosedPages(entry);

    return Array.from(entry.pages.entries())
      .filter(([, page]) => !page.isClosed())
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  private getNamedPagesByPage(entry: BrowserEntry): Map<Page, string> {
    const namesByPage = new Map<Page, string>();

    for (const [name, page] of entry.pages.entries()) {
      if (!page.isClosed() && !namesByPage.has(page)) {
        namesByPage.set(page, name);
      }
    }

    return namesByPage;
  }

  private getBrowserContexts(entry: BrowserEntry): BrowserContext[] {
    return [...new Set([entry.context, ...entry.browser.contexts()])];
  }

  private getContextPages(entry: BrowserEntry): Array<{ context: BrowserContext; page: Page }> {
    const pages: Array<{ context: BrowserContext; page: Page }> = [];

    for (const context of this.getBrowserContexts(entry)) {
      for (const page of context.pages()) {
        if (!page.isClosed()) {
          pages.push({ context, page });
        }
      }
    }

    return pages;
  }

  private async getPageTitle(page: Page): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        page.title(),
        new Promise<string>((resolve) => {
          timeoutId = setTimeout(() => resolve(""), PAGE_TITLE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async findPageByTargetId(entry: BrowserEntry, targetId: string): Promise<Page | null> {
    for (const { context, page } of this.getContextPages(entry)) {
      const pageTargetId = await this.getPageTargetId(context, page);
      if (pageTargetId === targetId) {
        return page;
      }
    }

    return null;
  }

  private async waitForPageByTargetId(
    entry: BrowserEntry,
    targetId: string,
    timeoutMs: number
  ): Promise<Page | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = await this.findPageByTargetId(entry, targetId);
      if (page) {
        return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  private summarizeRawTarget(target: CdpPageTarget): BrowserPageSummary {
    return {
      id: target.id,
      name: null,
      title: target.title,
      url: target.url,
    };
  }

  private async getPageTargetId(context: BrowserContext, page: Page): Promise<string | null> {
    let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;

    try {
      session = await context.newCDPSession(page);
      const result = await session.send("Target.getTargetInfo");
      const targetId =
        typeof result === "object" &&
        result !== null &&
        "targetInfo" in result &&
        typeof result.targetInfo === "object" &&
        result.targetInfo !== null &&
        "targetId" in result.targetInfo
          ? result.targetInfo.targetId
          : undefined;

      if (typeof targetId !== "string" || targetId.length === 0) {
        throw new Error("CDP target info did not include a targetId");
      }

      return targetId;
    } catch (error) {
      if (page.isClosed()) {
        return null;
      }

      throw error;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }
}
