import { describe, expect, it } from "vitest";

import { createBrowserPageLock, createKeyedLock, createMutex } from "./lock.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe("createKeyedLock", () => {
  it("serializes actions with the same key", async () => {
    const withLock = createKeyedLock<string>();
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    const events: string[] = [];

    const first = withLock("chromium", async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });

    await Promise.resolve();

    const second = withLock("chromium", async () => {
      events.push("second:start");
      secondGate.resolve();
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstGate.resolve();
    await first;
    await secondGate.promise;
    await second;

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("createMutex", () => {
  it("serializes all actions through a single lock", async () => {
    const withMutex = createMutex();
    const firstGate = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const events: string[] = [];

    const first = withMutex(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });

    await Promise.resolve();

    const second = withMutex(async () => {
      events.push("second:start");
      secondStarted.resolve();
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstGate.resolve();
    await first;
    await secondStarted.promise;
    await second;

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("createBrowserPageLock", () => {
  it("runs actions on different pages in parallel", async () => {
    const locks = createBrowserPageLock<string, string>();
    const startedAt = performance.now();

    await Promise.all([
      locks.withPageLock("chromium", "page-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }),
      locks.withPageLock("chromium", "page-b", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }),
    ]);

    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("serializes actions on the same page", async () => {
    const locks = createBrowserPageLock<string, string>();
    const startedAt = performance.now();

    await Promise.all([
      locks.withPageLock("chromium", "page-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }),
      locks.withPageLock("chromium", "page-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }),
    ]);

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(550);
  });

  it("makes a browser reconnect wait for active pages and block new page work", async () => {
    const locks = createBrowserPageLock<string, string>();
    const pageGate = createDeferred<void>();
    const reconnectGate = createDeferred<void>();
    const reconnectStarted = createDeferred<void>();
    const events: string[] = [];

    const activePage = locks.withPageLock("chromium", "page-a", async () => {
      events.push("page-a:start");
      await pageGate.promise;
      events.push("page-a:end");
    });
    await Promise.resolve();

    const reconnect = locks.withBrowserLock("chromium", async () => {
      events.push("reconnect:start");
      reconnectStarted.resolve();
      await reconnectGate.promise;
      events.push("reconnect:end");
    });
    const queuedPage = locks.withPageLock("chromium", "page-b", async () => {
      events.push("page-b:start");
      events.push("page-b:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["page-a:start"]);
    pageGate.resolve();
    await activePage;
    await reconnectStarted.promise;
    expect(events).toEqual(["page-a:start", "page-a:end", "reconnect:start"]);

    reconnectGate.resolve();
    await reconnect;
    await queuedPage;
    expect(events).toEqual([
      "page-a:start",
      "page-a:end",
      "reconnect:start",
      "reconnect:end",
      "page-b:start",
      "page-b:end",
    ]);
  });
});
