import type { ConnectOverCDPTransport } from "playwright";

export type CdpPageTarget = {
  id: string;
  title: string;
  url: string;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
  };
  sessionId?: string;
};

type PendingCommand = {
  method: string;
  reject: (error: Error) => void;
  resolve: (result: Record<string, unknown>) => void;
};

type PendingAttachEvent = {
  promise: Promise<void>;
  resolve: () => void;
};

type SelectiveCdpTransportOptions = {
  timeoutMs: number;
  webSocket?: typeof globalThis.WebSocket;
};

const INTERNAL_COMMAND_ID_START = 1_000_000_000;

export class SelectiveCdpTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;

  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly pendingAttachEvents = new Map<string, PendingAttachEvent>();
  private readonly targetSessions = new Map<string, string>();
  private readonly playwrightCreateTargetIds = new Set<number>();
  private nextInternalCommandId = INTERNAL_COMMAND_ID_START;
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleSocketMessage(event));
    socket.addEventListener("close", (event) => {
      const reason = event.reason || "CDP WebSocket closed";
      this.handleSocketClose(reason);
    });
    socket.addEventListener("error", () => {
      this.handleSocketClose("CDP WebSocket error");
    });
  }

  static async connect(
    endpoint: string,
    options: SelectiveCdpTransportOptions
  ): Promise<SelectiveCdpTransport> {
    const WebSocketImpl = options.webSocket ?? globalThis.WebSocket;
    if (typeof WebSocketImpl !== "function") {
      throw new Error("WebSocket is not available in this Node.js runtime");
    }

    const socket = new WebSocketImpl(endpoint);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error(`CDP WebSocket did not open within ${options.timeoutMs}ms`));
      }, options.timeoutMs);

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
        if (error) {
          try {
            socket.close();
          } catch {
            // Best effort after a failed handshake.
          }
          reject(error);
        } else {
          resolve();
        }
      };

      const handleOpen = () => finish();
      const handleError = () => finish(new Error(`Could not open CDP WebSocket at ${endpoint}`));
      const handleClose = (event: CloseEvent) =>
        finish(new Error(event.reason || `CDP WebSocket closed before opening at ${endpoint}`));

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    });

    return new SelectiveCdpTransport(socket);
  }

  send(message: object): void {
    const cdpMessage = message as CdpMessage;
    if (
      cdpMessage.method === "Target.setAutoAttach" &&
      cdpMessage.sessionId === undefined &&
      typeof cdpMessage.id === "number"
    ) {
      queueMicrotask(() => {
        this.onmessage?.({ id: cdpMessage.id, result: {} });
      });
      return;
    }

    if (
      cdpMessage.method === "Target.createTarget" &&
      cdpMessage.sessionId === undefined &&
      typeof cdpMessage.id === "number"
    ) {
      this.playwrightCreateTargetIds.add(cdpMessage.id);
    }

    this.sendToSocket(cdpMessage);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPendingCommands(new Error("CDP transport closed"));
    try {
      this.socket.close();
    } finally {
      this.onclose?.("CDP transport closed");
    }
  }

  async listPageTargets(): Promise<CdpPageTarget[]> {
    const result = await this.sendInternalCommand("Target.getTargets");
    const targetInfos = result.targetInfos;
    if (!Array.isArray(targetInfos)) {
      throw new Error("Target.getTargets did not return a target list");
    }

    return targetInfos.flatMap((target): CdpPageTarget[] => {
      if (!target || typeof target !== "object") {
        return [];
      }
      const info = target as Record<string, unknown>;
      if (
        info.type !== "page" ||
        typeof info.targetId !== "string" ||
        typeof info.url !== "string"
      ) {
        return [];
      }
      return [
        {
          id: info.targetId,
          title: typeof info.title === "string" ? info.title : "",
          url: info.url,
        },
      ];
    });
  }

  async activateTarget(targetId: string): Promise<void> {
    await this.sendInternalCommand("Target.activateTarget", { targetId });
  }

  async attachToTarget(targetId: string): Promise<void> {
    const targetInfoResult = await this.sendInternalCommand("Target.getTargetInfo", {
      targetId,
    });
    const targetInfo = targetInfoResult.targetInfo;
    if (!targetInfo || typeof targetInfo !== "object") {
      throw new Error(`Target.getTargetInfo returned no information for ${targetId}`);
    }

    let resolveAttachEvent = () => {};
    const attachEventPromise = new Promise<void>((resolve) => {
      resolveAttachEvent = resolve;
    });
    this.pendingAttachEvents.set(targetId, {
      promise: attachEventPromise,
      resolve: resolveAttachEvent,
    });

    try {
      const attachResult = await this.sendInternalCommand("Target.attachToTarget", {
        flatten: true,
        targetId,
      });
      const sessionId = attachResult.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`Target.attachToTarget returned no sessionId for ${targetId}`);
      }
      this.targetSessions.set(targetId, sessionId);
      const observedNaturally = await Promise.race([
        attachEventPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      if (!observedNaturally) {
        this.onmessage?.({
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: {
              ...(targetInfo as Record<string, unknown>),
              attached: true,
            },
            waitingForDebugger: false,
          },
        });
      }
    } finally {
      this.pendingAttachEvents.delete(targetId);
    }
  }

  async detachFromTarget(targetId: string): Promise<void> {
    const sessionId = this.targetSessions.get(targetId);
    if (!sessionId) {
      return;
    }
    try {
      await this.sendInternalCommand("Target.detachFromTarget", { sessionId });
    } finally {
      this.targetSessions.delete(targetId);
    }
  }

  private sendInternalCommand(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new Error("CDP transport is closed"));
    }

    const id = this.nextInternalCommandId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pendingCommands.set(id, { method, reject, resolve });
      try {
        this.sendToSocket({ id, method, params });
      } catch (error) {
        this.pendingCommands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendToSocket(message: CdpMessage): void {
    if (this.closed) {
      throw new Error("CDP transport is closed");
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleSocketMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.handleSocketClose("Received a non-text CDP message");
      return;
    }

    let message: CdpMessage;
    try {
      message = JSON.parse(event.data) as CdpMessage;
    } catch {
      this.handleSocketClose("Received invalid JSON from CDP");
      return;
    }

    if (message.method === "Target.attachedToTarget") {
      const targetInfo = message.params?.targetInfo;
      const targetId =
        targetInfo && typeof targetInfo === "object"
          ? (targetInfo as Record<string, unknown>).targetId
          : undefined;
      if (typeof targetId === "string") {
        this.pendingAttachEvents.get(targetId)?.resolve();
      }
    }

    if (typeof message.id === "number") {
      const pending = this.pendingCommands.get(message.id);
      if (pending) {
        this.pendingCommands.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              `${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`
            )
          );
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }

      if (this.playwrightCreateTargetIds.delete(message.id)) {
        const targetId = message.result?.targetId;
        if (typeof targetId === "string") {
          void this.attachToTarget(targetId)
            .then(() => this.onmessage?.(message))
            .catch((error) => {
              this.handleSocketClose(
                error instanceof Error ? error.message : `Could not attach target ${targetId}`
              );
            });
        } else {
          this.onmessage?.(message);
        }
        return;
      }
    }

    this.onmessage?.(message);
  }

  private handleSocketClose(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPendingCommands(new Error(reason));
    this.onclose?.(reason);
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }
}
