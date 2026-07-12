import { deserialize, Reader, serialize } from "./serialization.js";
import { PersistentProtocol } from "./persistentProtocol.js";

const enum ResponseType {
  Initialize = 200,
  PromiseSuccess = 201,
  PromiseError = 202,
  PromiseErrorObject = 203,
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RemoteRpcError extends Error {
  public constructor(message: string, name = "RemoteRpcError") {
    super(message);
    this.name = name;
  }
}

export class IpcClient {
  private requestId = 0;
  private initialized = false;
  private readonly pending = new Map<number, PendingCall>();
  private initializeResolve: (() => void) | undefined;
  private initializeReject: ((error: Error) => void) | undefined;

  public constructor(
    private readonly protocol: PersistentProtocol,
    private readonly timeoutMs = 30_000,
  ) {
    protocol.on("message", (message: Buffer) => this.receive(message));
    protocol.on("close", (error: Error) => this.failAll(error));
  }

  public async start(context: { remoteAuthority: string; clientId: string }): Promise<void> {
    const initialized = new Promise<void>((resolve, reject) => {
      this.initializeResolve = resolve;
      this.initializeReject = reject;
    });
    await this.protocol.sendRegular(serialize(context));
    await this.protocol.sendRegular(serialize([ResponseType.Initialize], undefined));
    const timer = setTimeout(() => {
      this.initializeReject?.(new Error("VS Code IPC initialization timed out"));
    }, this.timeoutMs);
    try {
      await initialized;
    } finally {
      clearTimeout(timer);
      this.initializeResolve = undefined;
      this.initializeReject = undefined;
    }
  }

  public async call(channel: string, command: string, argument: unknown): Promise<unknown> {
    if (!this.initialized) {
      throw new Error("VS Code IPC client is not initialized");
    }
    const id = this.requestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`remoteFilesystem ${command} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.protocol.sendRegular(serialize([100, id, channel, command], argument));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  public dispose(error = new Error("VS Code IPC client disposed")): void {
    this.failAll(error);
  }

  private receive(message: Buffer): void {
    try {
      const reader = new Reader(message);
      const header = deserialize(reader);
      const body = deserialize(reader);
      if (!Array.isArray(header) || typeof header[0] !== "number") {
        throw new Error("Malformed VS Code IPC response header");
      }
      const type = header[0] as ResponseType;
      if (type === ResponseType.Initialize) {
        this.initialized = true;
        this.initializeResolve?.();
        return;
      }
      const id = header[1];
      if (typeof id !== "number") {
        throw new Error("Malformed VS Code IPC response id");
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (type === ResponseType.PromiseSuccess) {
        pending.resolve(body);
      } else if (type === ResponseType.PromiseError) {
        const remote = body as { message?: unknown; name?: unknown };
        pending.reject(
          new RemoteRpcError(
            typeof remote?.message === "string" ? remote.message : "remote RPC failed",
            typeof remote?.name === "string" ? remote.name : undefined,
          ),
        );
      } else if (type === ResponseType.PromiseErrorObject) {
        pending.reject(new RemoteRpcError(`remote RPC failed: ${JSON.stringify(body)}`));
      }
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failAll(error: Error): void {
    this.initialized = false;
    this.initializeReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
