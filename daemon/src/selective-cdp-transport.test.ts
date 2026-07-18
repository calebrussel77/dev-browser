import { describe, expect, it } from "vitest";

import { SelectiveCdpTransport } from "./selective-cdp-transport.js";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  sessionId?: string;
};

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];

  readonly sent: CdpMessage[] = [];
  readyState = 0;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as CdpMessage);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { reason: "closed by test" }));
  }

  receive(message: CdpMessage): void {
    const event = new MessageEvent("message", {
      data: JSON.stringify(message),
    });
    this.dispatchEvent(event);
  }
}

async function createTransport(): Promise<{
  socket: FakeWebSocket;
  transport: SelectiveCdpTransport;
}> {
  FakeWebSocket.instances = [];
  const transport = await SelectiveCdpTransport.connect(
    "ws://127.0.0.1:9222/devtools/browser/test",
    {
      timeoutMs: 1_000,
      webSocket: FakeWebSocket as unknown as typeof globalThis.WebSocket,
    }
  );
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("fake socket was not created");
  }
  return { socket, transport };
}

describe("SelectiveCdpTransport", () => {
  it("acknowledges root Target.setAutoAttach without forwarding it", async () => {
    const { socket, transport } = await createTransport();
    const messages: CdpMessage[] = [];
    transport.onmessage = (message) => messages.push(message as CdpMessage);

    transport.send({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
    });
    await Promise.resolve();

    expect(socket.sent).toEqual([]);
    expect(messages).toEqual([{ id: 1, result: {} }]);
  });

  it("forwards session-scoped Target.setAutoAttach unchanged", async () => {
    const { socket, transport } = await createTransport();
    const command = {
      id: 2,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
      sessionId: "page-session",
    };

    transport.send(command);

    expect(socket.sent).toEqual([command]);
  });

  it("returns page targets from Target.getTargets", async () => {
    const { socket, transport } = await createTransport();

    const targetsPromise = transport.listPageTargets();
    const command = socket.sent.at(-1);
    expect(command?.method).toBe("Target.getTargets");
    socket.receive({
      id: command?.id,
      result: {
        targetInfos: [
          { targetId: "page-1", type: "page", title: "Inbox", url: "https://mail.test" },
          { targetId: "worker-1", type: "service_worker", title: "", url: "worker.js" },
        ],
      },
    });

    await expect(targetsPromise).resolves.toEqual([
      { id: "page-1", title: "Inbox", url: "https://mail.test" },
    ]);
  });

  it("activates one exact target before Playwright attaches it", async () => {
    const { socket, transport } = await createTransport();

    const activation = transport.activateTarget("page-2");
    const command = socket.sent.at(-1);
    expect(command).toMatchObject({
      method: "Target.activateTarget",
      params: { targetId: "page-2" },
    });
    socket.receive({ id: command?.id, result: {} });

    await expect(activation).resolves.toBeUndefined();
  });

  it("explicitly attaches one requested target", async () => {
    const { socket, transport } = await createTransport();
    const messages: CdpMessage[] = [];
    transport.onmessage = (message) => messages.push(message as CdpMessage);

    const attachPromise = transport.attachToTarget("page-1");
    const targetInfoCommand = socket.sent.at(-1);
    expect(targetInfoCommand).toMatchObject({
      method: "Target.getTargetInfo",
      params: { targetId: "page-1" },
    });
    const targetInfo = {
      browserContextId: "context-1",
      targetId: "page-1",
      title: "Inbox",
      type: "page",
      url: "https://mail.test",
    };
    socket.receive({ id: targetInfoCommand?.id, result: { targetInfo } });
    await Promise.resolve();

    const attachCommand = socket.sent.at(-1);
    expect(attachCommand).toMatchObject({
      method: "Target.attachToTarget",
      params: { flatten: true, targetId: "page-1" },
    });
    socket.receive({ id: attachCommand?.id, result: { sessionId: "session-1" } });
    await expect(attachPromise).resolves.toBeUndefined();
    expect(messages).toContainEqual({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "session-1",
        targetInfo: { ...targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });
  });

  it("attaches a Playwright-created target after Target.createTarget succeeds", async () => {
    const { socket, transport } = await createTransport();
    const messages: CdpMessage[] = [];
    transport.onmessage = (message) => messages.push(message as CdpMessage);

    transport.send({ id: 7, method: "Target.createTarget", params: { url: "about:blank" } });
    socket.receive({ id: 7, result: { targetId: "created-page" } });
    await Promise.resolve();

    expect(messages).toEqual([]);
    const targetInfoCommand = socket.sent.at(-1);
    expect(targetInfoCommand).toMatchObject({
      method: "Target.getTargetInfo",
      params: { targetId: "created-page" },
    });
    socket.receive({
      id: targetInfoCommand?.id,
      result: {
        targetInfo: {
          browserContextId: "context-1",
          targetId: "created-page",
          title: "",
          type: "page",
          url: "about:blank",
        },
      },
    });
    await Promise.resolve();

    const attachCommand = socket.sent.at(-1);
    expect(attachCommand).toMatchObject({
      method: "Target.attachToTarget",
      params: { flatten: true, targetId: "created-page" },
    });
    socket.receive({ id: attachCommand?.id, result: { sessionId: "created-session" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(messages.at(-1)).toEqual({ id: 7, result: { targetId: "created-page" } });
  });

  it("rejects pending commands when the socket closes", async () => {
    const { socket, transport } = await createTransport();

    const targetsPromise = transport.listPageTargets();
    socket.close();

    await expect(targetsPromise).rejects.toThrow(/closed by test/);
  });
});
