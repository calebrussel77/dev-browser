type AsyncAction<T> = () => Promise<T>;

export function createKeyedLock<K>() {
  const locks = new Map<K, Promise<void>>();

  return async function withLock<T>(key: K, action: AsyncAction<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    locks.set(key, tail);

    await previous.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (locks.get(key) === tail) {
        locks.delete(key);
      }
    }
  };
}

export function createMutex() {
  const withLock = createKeyedLock<symbol>();
  const lockKey = Symbol("mutex");

  return function withMutex<T>(action: AsyncAction<T>): Promise<T> {
    return withLock(lockKey, action);
  };
}

type BrowserPageRequest<P> = {
  kind: "browser" | "page";
  page?: P;
  action: AsyncAction<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type BrowserPageLockState<P> = {
  activeBrowser: boolean;
  activePages: Set<P>;
  queue: BrowserPageRequest<P>[];
};

export function createBrowserPageLock<B, P>() {
  const states = new Map<B, BrowserPageLockState<P>>();

  const getState = (browser: B): BrowserPageLockState<P> => {
    let state = states.get(browser);
    if (!state) {
      state = {
        activeBrowser: false,
        activePages: new Set<P>(),
        queue: [],
      };
      states.set(browser, state);
    }
    return state;
  };

  const drain = (browser: B, state: BrowserPageLockState<P>): void => {
    if (state.activeBrowser) {
      return;
    }

    const finish = (request: BrowserPageRequest<P>) => {
      if (request.kind === "browser") {
        state.activeBrowser = false;
      } else {
        state.activePages.delete(request.page!);
      }

      if (!state.activeBrowser && state.activePages.size === 0 && state.queue.length === 0) {
        states.delete(browser);
        return;
      }
      drain(browser, state);
    };

    const start = (request: BrowserPageRequest<P>) => {
      void Promise.resolve()
        .then(request.action)
        .then(request.resolve, request.reject)
        .finally(() => finish(request));
    };

    const first = state.queue[0];
    if (first?.kind === "browser") {
      if (state.activePages.size > 0) {
        return;
      }
      state.queue.shift();
      state.activeBrowser = true;
      start(first);
      return;
    }

    let index = 0;
    while (index < state.queue.length) {
      const request = state.queue[index]!;
      if (request.kind === "browser") {
        break;
      }
      const page = request.page!;
      if (state.activePages.has(page)) {
        index += 1;
        continue;
      }
      state.queue.splice(index, 1);
      state.activePages.add(page);
      start(request);
    }
  };

  const enqueue = <T>(browser: B, request: Omit<BrowserPageRequest<P>, "resolve" | "reject">) =>
    new Promise<T>((resolve, reject) => {
      const state = getState(browser);
      state.queue.push({
        ...request,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      drain(browser, state);
    });

  return {
    withBrowserLock<T>(browser: B, action: AsyncAction<T>): Promise<T> {
      return enqueue<T>(browser, { kind: "browser", action });
    },
    withPageLock<T>(browser: B, page: P, action: AsyncAction<T>): Promise<T> {
      return enqueue<T>(browser, { kind: "page", page, action });
    },
  };
}
