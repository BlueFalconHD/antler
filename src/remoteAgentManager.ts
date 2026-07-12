import { EventEmitter } from "node:events";
import type { CodeServerSession } from "./auth/codeServerAuth.js";
import type { CompatibilityProfile } from "./compatibility/profiles.js";
import { connectRemoteAgent, type RemoteAgentConnection } from "./vscode/handshake.js";
import { RemoteFileSystemClient } from "./vscode/remoteFileSystem.js";

export interface RemoteAgentManagerOptions {
  readonly session: CodeServerSession;
  readonly profile: CompatibilityProfile;
  readonly rejectUnauthorized: boolean;
  readonly sendOrigin: boolean;
  readonly connector?: typeof connectRemoteAgent;
}

export interface RemoteFileSystemLease {
  readonly client: RemoteFileSystemClient;
  readonly generation: number;
}

export class RemoteAgentManager extends EventEmitter {
  private connection: RemoteAgentConnection | undefined;
  private client: RemoteFileSystemClient | undefined;
  private connecting: Promise<RemoteFileSystemLease> | undefined;
  private generation = 0;
  private stopped = false;

  public constructor(private readonly options: RemoteAgentManagerOptions) {
    super();
  }

  public get currentGeneration(): number {
    return this.generation;
  }

  public async get(): Promise<RemoteFileSystemLease> {
    if (this.stopped) {
      throw new Error("remote agent manager is stopped");
    }
    if (this.connection && this.client) {
      return { client: this.client, generation: this.generation };
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  public assertGeneration(generation: number): void {
    if (generation !== this.generation || !this.connection) {
      throw new Error("remote connection was lost; handle is no longer valid");
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    const connection = this.connection;
    this.connection = undefined;
    this.client = undefined;
    if (connection) {
      await connection.close();
    }
  }

  private async connect(): Promise<RemoteFileSystemLease> {
    const connection = await (this.options.connector ?? connectRemoteAgent)(this.options);
    this.generation += 1;
    const generation = this.generation;
    const client = new RemoteFileSystemClient(connection.ipc, connection.remoteAuthority);
    this.connection = connection;
    this.client = client;
    connection.protocol.once("close", (error: Error) => {
      if (this.connection !== connection) {
        return;
      }
      this.connection = undefined;
      this.client = undefined;
      this.emit("disconnect", { generation, error });
    });
    return { client, generation };
  }
}
