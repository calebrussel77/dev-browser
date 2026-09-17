import type { BrowserManager } from "../browser-manager.js";
import { QuickJSSandbox } from "./quickjs-sandbox.js";

interface ScriptOutput {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}

export async function runScript(
  script: string,
  manager: BrowserManager,
  browserName: string,
  output: ScriptOutput,
  options: { timeout?: number; memoryLimitBytes?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: output.onStdout,
    onStderr: output.onStderr,
    memoryLimitBytes: options.memoryLimitBytes,
    timeoutMs: options.timeout,
  });

  const onAbort = () => {
    sandbox.abort(
      new Error(
        "Script aborted: the client that submitted it disconnected before it finished"
      )
    );
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    await sandbox.initialize();
    await sandbox.executeScript(`(async () => {\n${script}\n})()`);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await sandbox.dispose();
  }
}
