import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { AgentProtocolError } from "./agent-protocol.js";
import { ensureTrustedInputDeliverable } from "./window-visibility.js";

const page = {} as Page;

function probeSequence(results: boolean[]) {
  let call = 0;
  const calls: number[] = [];
  return {
    calls,
    probe: async () => {
      calls.push(call);
      const result = results[Math.min(call, results.length - 1)]!;
      call += 1;
      return result;
    },
  };
}

describe("ensureTrustedInputDeliverable", () => {
  it("does nothing when the renderer is producing frames", async () => {
    let brought = 0;
    const result = await ensureTrustedInputDeliverable(page, "main", {
      probe: async () => true,
      bringToFront: async () => {
        brought += 1;
      },
      restoreWindow: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result).toBeNull();
    expect(brought).toBe(0);
  });

  it("activates a background tab when that alone revives rendering", async () => {
    const { probe } = probeSequence([false, true]);
    let brought = 0;
    const result = await ensureTrustedInputDeliverable(page, "main", {
      probe,
      bringToFront: async () => {
        brought += 1;
      },
      restoreWindow: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result?.method).toBe("bring-to-front");
    expect(brought).toBe(1);
  });

  it("restores the window and gives focus back on win32", async () => {
    const { probe } = probeSequence([false, false, true]);
    const events: string[] = [];
    const result = await ensureTrustedInputDeliverable(page, "main", {
      platform: "win32",
      probe,
      bringToFront: async () => {
        events.push("bring-to-front");
      },
      captureForeground: async () => {
        events.push("capture-foreground");
        return 4242;
      },
      restoreWindow: async () => {
        events.push("restore-window");
        return true;
      },
      restoreForeground: async (handle) => {
        events.push(`restore-foreground:${handle}`);
      },
    });
    expect(result?.method).toBe("window-restore");
    expect(result?.warnings.join(" ")).toContain("--disable-backgrounding-occluded-windows");
    expect(events).toEqual([
      "bring-to-front",
      "capture-foreground",
      "restore-window",
      "restore-foreground:4242",
    ]);
  });

  it("skips foreground capture off win32", async () => {
    const { probe } = probeSequence([false, false, true]);
    const result = await ensureTrustedInputDeliverable(page, "main", {
      platform: "darwin",
      probe,
      bringToFront: async () => {},
      captureForeground: async () => {
        throw new Error("must not be called");
      },
      restoreWindow: async () => true,
      restoreForeground: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result?.method).toBe("window-restore");
  });

  it("throws WINDOW_OCCLUDED and still hands focus back when nothing revives the renderer", async () => {
    const events: string[] = [];
    await expect(
      ensureTrustedInputDeliverable(page, "main", {
        platform: "win32",
        probe: async () => false,
        bringToFront: async () => {},
        captureForeground: async () => 777,
        restoreWindow: async () => true,
        restoreForeground: async (handle) => {
          events.push(`restore-foreground:${handle}`);
        },
      })
    ).rejects.toMatchObject({ code: "WINDOW_OCCLUDED", recoverable: true });
    expect(events).toEqual(["restore-foreground:777"]);
  });

  it("throws WINDOW_OCCLUDED when the window restore itself fails", async () => {
    await expect(
      ensureTrustedInputDeliverable(page, "main", {
        platform: "linux",
        probe: async () => false,
        bringToFront: async () => {
          throw new Error("no target");
        },
        restoreWindow: async () => false,
      })
    ).rejects.toBeInstanceOf(AgentProtocolError);
  });
});
