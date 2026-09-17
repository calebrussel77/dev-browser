import type { BrowserManager } from "../browser-manager.js";
import type { Browser } from "playwright";
import { QuickJSSandbox } from "./quickjs-sandbox.js";

interface ScriptOutput {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}

interface WarmSandbox {
  output?: ScriptOutput;
  sandbox: QuickJSSandbox;
}

interface SandboxPoolSlot {
  browser: Browser;
  disconnectListener: () => void;
  signature: string;
  warm?: Promise<WarmSandbox>;
}

interface SandboxLease {
  replenish: () => void;
  warmSandbox: WarmSandbox;
}

const sandboxPools = new WeakMap<BrowserManager, Map<string, SandboxPoolSlot>>();

function optionSignature(options: { timeout?: number; memoryLimitBytes?: number }): string {
  return `${options.timeout ?? "default"}:${options.memoryLimitBytes ?? "default"}`;
}

async function createWarmSandbox(
  manager: BrowserManager,
  browserName: string,
  options: { timeout?: number; memoryLimitBytes?: number }
): Promise<WarmSandbox> {
  const holder: WarmSandbox = {
    sandbox: undefined as unknown as QuickJSSandbox,
  };
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: (data) => holder.output?.onStdout(data),
    onStderr: (data) => holder.output?.onStderr(data),
    memoryLimitBytes: options.memoryLimitBytes,
    timeoutMs: options.timeout,
  });
  holder.sandbox = sandbox;

  try {
    await sandbox.initialize();
    return holder;
  } catch (error) {
    await sandbox.dispose();
    throw error;
  }
}

function createPooledWarmSandbox(
  manager: BrowserManager,
  browserName: string,
  options: { timeout?: number; memoryLimitBytes?: number }
): Promise<WarmSandbox> {
  const warm = createWarmSandbox(manager, browserName, options);
  void warm.catch(() => undefined);
  return warm;
}

function disposeWarmSandbox(warm: Promise<WarmSandbox> | undefined): void {
  if (!warm) {
    return;
  }
  void warm.then(({ sandbox }) => sandbox.dispose()).catch(() => undefined);
}

function poolFor(manager: BrowserManager): Map<string, SandboxPoolSlot> {
  let pool = sandboxPools.get(manager);
  if (!pool) {
    pool = new Map<string, SandboxPoolSlot>();
    sandboxPools.set(manager, pool);
  }
  return pool;
}

function invalidateSlot(
  manager: BrowserManager,
  browserName: string,
  slot: SandboxPoolSlot
): void {
  const pool = sandboxPools.get(manager);
  if (pool?.get(browserName) !== slot) {
    return;
  }
  pool.delete(browserName);
  slot.browser.off("disconnected", slot.disconnectListener);
  disposeWarmSandbox(slot.warm);
}

async function acquireSandbox(
  manager: BrowserManager,
  browserName: string,
  options: { timeout?: number; memoryLimitBytes?: number }
): Promise<SandboxLease> {
  const browser = manager.getBrowser(browserName)?.browser;
  if (!browser) {
    throw new Error(
      `Browser "${browserName}" not found. It should have been created before script execution.`
    );
  }

  const signature = optionSignature(options);
  const pool = poolFor(manager);
  let slot = pool.get(browserName);
  if (slot && (slot.browser !== browser || slot.signature !== signature)) {
    invalidateSlot(manager, browserName, slot);
    slot = undefined;
  }

  let current: Promise<WarmSandbox>;
  let coldStart = false;
  if (!slot) {
    coldStart = true;
    current = createWarmSandbox(manager, browserName, options);
    const disconnectListener = () => {
      const activeSlot = sandboxPools.get(manager)?.get(browserName);
      if (activeSlot) {
        invalidateSlot(manager, browserName, activeSlot);
      }
    };
    slot = {
      browser,
      disconnectListener,
      signature,
      warm: createPooledWarmSandbox(manager, browserName, options),
    };
    browser.once("disconnected", disconnectListener);
    pool.set(browserName, slot);
  } else {
    current = slot.warm ?? createWarmSandbox(manager, browserName, options);
    slot.warm = undefined;
  }

  try {
    let warmSandbox: WarmSandbox;
    if (coldStart) {
      const [ready] = await Promise.all([current, slot.warm!]);
      warmSandbox = ready;
    } else {
      warmSandbox = await current;
    }
    return {
      warmSandbox,
      replenish: () => {
        const activeSlot = sandboxPools.get(manager)?.get(browserName);
        if (activeSlot !== slot || activeSlot.warm || !browser.isConnected()) {
          return;
        }
        activeSlot.warm = createPooledWarmSandbox(manager, browserName, options);
      },
    };
  } catch (error) {
    invalidateSlot(manager, browserName, slot);
    throw error;
  }
}

export async function runScript(
  script: string,
  manager: BrowserManager,
  browserName: string,
  output: ScriptOutput,
  options: { timeout?: number; memoryLimitBytes?: number } = {}
): Promise<void> {
  const lease = await acquireSandbox(manager, browserName, options);
  const { warmSandbox } = lease;
  warmSandbox.output = output;
  let completed = false;

  try {
    await warmSandbox.sandbox.executeScript(`(async () => {\n${script}\n})()`);
    completed = true;
  } finally {
    warmSandbox.output = undefined;
    lease.replenish();
    if (completed) {
      void warmSandbox.sandbox.dispose().catch(() => undefined);
    } else {
      await warmSandbox.sandbox.dispose();
    }
  }
}
