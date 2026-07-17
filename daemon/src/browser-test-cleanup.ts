import type { BrowserManager } from "./browser-manager.js";
import { removeDirectoryWithRetries } from "./test-cleanup.js";

const WINDOWS_RELEASE_ATTEMPTS = 6;
const WINDOWS_RELEASE_BASE_DELAY_MS = 100;

function isWindowsReleaseError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM";
}

export async function stopBrowserManagerAndRemoveDirectory(
  manager: BrowserManager,
  directory: string
): Promise<void> {
  await manager.stopAll();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await removeDirectoryWithRetries(directory);
      return;
    } catch (error) {
      if (!isWindowsReleaseError(error) || attempt >= WINDOWS_RELEASE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, WINDOWS_RELEASE_BASE_DELAY_MS * attempt));
    }
  }
}
