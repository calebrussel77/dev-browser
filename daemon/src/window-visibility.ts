import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CDPSession, Page } from "playwright";
import { AgentProtocolError } from "./agent-protocol.js";

const execFileAsync = promisify(execFile);

/** Probe budget for a healthy page: one animation frame arrives within ~16ms,
 * so a visible renderer resolves almost immediately and only a frozen renderer
 * pays the full budget. */
const FRAME_PROBE_TIMEOUT_MS = 400;
/** Budget for post-remediation probes: waking a renderer takes a few frames. */
const REVIVE_PROBE_TIMEOUT_MS = 1_500;
const FOREGROUND_HELPER_TIMEOUT_MS = 6_000;

export const OCCLUSION_LAUNCH_FLAG = "--disable-backgrounding-occluded-windows";

export interface WindowVisibilityRemediation {
  method: "bring-to-front" | "window-restore";
  warnings: string[];
}

/**
 * True when the page's renderer is producing animation frames. A renderer whose
 * OS window is fully occluded by other windows (and not foreground) stops
 * compositing: JavaScript still runs and reads still work, but trusted input
 * dispatched through CDP is dropped without an error or times out. Frame
 * production is the observable precursor of that state — `document.visibilityState`
 * alone is not reliable on Windows, where it can stay "visible" for minutes
 * after the window is covered or even minimized.
 */
export async function rendererProducingFrames(
  page: Page,
  timeoutMs = FRAME_PROBE_TIMEOUT_MS
): Promise<boolean> {
  try {
    return await page.evaluate(
      (budget) =>
        new Promise<boolean>((resolve) => {
          let fired = false;
          requestAnimationFrame(() => {
            fired = true;
            resolve(true);
          });
          setTimeout(() => {
            if (!fired) resolve(false);
          }, budget);
        }),
      timeoutMs
    );
  } catch {
    // Never turn a probe failure into an input blocker; the action's own error
    // path produces a better-typed failure than the guard could.
    return true;
  }
}

/** Chrome only wakes an occluded window when the window physically stops being
 * occluded: it must be raised above its coverers, which Windows permits only
 * for the window's own process. Minimize/restore through CDP makes Chrome
 * restore its own window, raising and focusing it. Hidden/show cycles, z-order
 * raises from other processes, bounds nudges, screencast, and no-activate
 * restores were all verified ineffective against a fully covered window. */
async function restoreWindowThroughCdp(page: Page): Promise<boolean> {
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const { windowId } = (await session.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    return true;
  } catch {
    return false;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

/** The window handle that currently has foreground focus, so it can be given
 * back after Chrome's self-restore steals it. Returns null when unavailable. */
async function captureForegroundWindow(): Promise<number | null> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DevBrowserFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
Write-Output ([Int64][DevBrowserFg]::GetForegroundWindow())
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: FOREGROUND_HELPER_TIMEOUT_MS, windowsHide: true }
    );
    const handle = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(handle) && handle > 0 ? handle : null;
  } catch {
    return null;
  }
}

/** Returns focus to the window the user was working in before remediation.
 * The transient ALT keypress lifts the foreground lock Windows imposes on
 * background processes; without it SetForegroundWindow silently fails. */
async function restoreForegroundWindow(handle: number): Promise<void> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DevBrowserFg {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$handle = [IntPtr]${handle}
if ([DevBrowserFg]::IsWindow($handle)) {
  [DevBrowserFg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [DevBrowserFg]::SetForegroundWindow($handle) | Out-Null
  [DevBrowserFg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
}
`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: FOREGROUND_HELPER_TIMEOUT_MS,
    windowsHide: true,
  }).catch(() => undefined);
}

export interface EnsureTrustedInputDeliverableOptions {
  platform?: NodeJS.Platform;
  probe?: (page: Page, timeoutMs?: number) => Promise<boolean>;
  bringToFront?: (page: Page) => Promise<void>;
  restoreWindow?: (page: Page) => Promise<boolean>;
  captureForeground?: () => Promise<number | null>;
  restoreForeground?: (handle: number) => Promise<void>;
}

/**
 * Guarantees the page can receive trusted input before an action dispatches
 * it, remediating the occluded-window state that otherwise surfaces as
 * inexplicable click timeouts or silently dropped events while reads keep
 * working. Escalates from the least intrusive remedy: activate the tab, then
 * have Chrome restore its own window (the only wake-up that works against a
 * fully covered window) and hand focus straight back to the user's previous
 * window. Throws WINDOW_OCCLUDED when every strategy fails, so callers get an
 * explicit, actionable error instead of a generic timeout.
 */
export async function ensureTrustedInputDeliverable(
  page: Page,
  pageName: string,
  options: EnsureTrustedInputDeliverableOptions = {}
): Promise<WindowVisibilityRemediation | null> {
  const {
    platform = process.platform,
    probe = rendererProducingFrames,
    bringToFront = (target) => target.bringToFront(),
    restoreWindow = restoreWindowThroughCdp,
    captureForeground = captureForegroundWindow,
    restoreForeground = restoreForegroundWindow,
  } = options;

  if (await probe(page, FRAME_PROBE_TIMEOUT_MS)) return null;

  const permanentFix = `For a permanent fix, relaunch the connected Chrome with ${OCCLUSION_LAUNCH_FLAG}`;

  // Cheapest first: the tab may simply be in the background of a visible window.
  await bringToFront(page).catch(() => undefined);
  if (await probe(page, REVIVE_PROBE_TIMEOUT_MS)) {
    return {
      method: "bring-to-front",
      warnings: [
        "The target tab was not rendering; it was activated automatically before trusted input",
      ],
    };
  }

  const previousForeground = platform === "win32" ? await captureForeground() : null;
  if (await restoreWindow(page)) {
    const revived = await probe(page, REVIVE_PROBE_TIMEOUT_MS);
    // Give focus back even when the probe stayed dead: the restore took the
    // foreground either way, and the user's window must not keep paying for a
    // failed remediation.
    if (previousForeground !== null) {
      await restoreForeground(previousForeground);
    }
    if (revived) {
      return {
        method: "window-restore",
        warnings: [
          `The browser window was fully covered by other windows, freezing its renderer; it was restored to wake it and focus was handed back to the previously active window. ${permanentFix}`,
        ],
      };
    }
  }

  throw new AgentProtocolError(
    "WINDOW_OCCLUDED",
    `The browser window is fully covered by other windows, so Chrome froze its renderer and trusted input (clicks, typing, scrolling) is silently dropped or times out even though reads still work. Automatic remediation failed. Bring the window out from behind other windows, or relaunch the connected Chrome with ${OCCLUSION_LAUNCH_FLAG} to make it immune to occlusion.`,
    true,
    {
      details: { pageName, remediation: "exhausted" },
    }
  );
}
