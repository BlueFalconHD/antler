import { IpcClient } from "./ipcClient.js";
import { vsBuffer } from "./serialization.js";

export const enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export const enum FilePermission {
  Locked = 1,
}

export interface RemoteStat {
  readonly type: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
  readonly permissions?: number;
}

export interface RemoteDirectoryEntry {
  readonly name: string;
  readonly type: number;
}

interface UriComponents {
  readonly $mid: 1;
  readonly scheme: "vscode-remote";
  readonly authority: string;
  readonly path: string;
}

export class RemoteFileSystemClient {
  private readonly fdOperations = new Map<number, Promise<void>>();

  public constructor(
    private readonly ipc: IpcClient,
    private readonly remoteAuthority: string,
    private readonly writePreservingOpenOptions?: Readonly<Record<string, unknown>>,
  ) {}

  public get supportsAtomicPartialWrite(): boolean {
    return this.writePreservingOpenOptions !== undefined;
  }

  public async stat(path: string): Promise<RemoteStat> {
    return (await this.call("stat", [this.uri(path)])) as RemoteStat;
  }

  public async readdir(path: string): Promise<RemoteDirectoryEntry[]> {
    const entries = (await this.call("readdir", [this.uri(path)])) as [string, number][];
    return entries.map(([name, type]) => ({ name, type }));
  }

  public async readFile(path: string): Promise<Buffer> {
    const result = await this.call("readFile", [this.uri(path), undefined]);
    if (!Buffer.isBuffer(result)) {
      throw new Error("malformed remoteFilesystem readFile response");
    }
    return result;
  }

  public async openRead(path: string): Promise<number> {
    return (await this.call("open", [this.uri(path), { create: false }])) as number;
  }

  public async openWriteTruncate(path: string): Promise<number> {
    return (await this.call("open", [this.uri(path), { create: true, unlock: false }])) as number;
  }

  public async openWritePreserve(path: string): Promise<number> {
    if (!this.writePreservingOpenOptions) {
      throw new Error("selected compatibility profile does not support non-truncating write-open");
    }
    return (await this.call("open", [this.uri(path), this.writePreservingOpenOptions])) as number;
  }

  public read(fd: number, position: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
      return Promise.reject(new Error("invalid remote read range"));
    }
    return this.withFd(fd, async () => {
      const result = (await this.call("read", [fd, position, length])) as [Buffer, number];
      const [buffer, bytesRead] = result;
      if (!Buffer.isBuffer(buffer) || !Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) {
        throw new Error("malformed remoteFilesystem read response");
      }
      return buffer.subarray(0, bytesRead);
    });
  }

  public write(fd: number, position: number, data: Buffer): Promise<void> {
    if (!Number.isSafeInteger(position) || position < 0) {
      return Promise.reject(new Error("invalid remote write offset"));
    }
    return this.withFd(fd, async () => {
      let offset = 0;
      while (offset < data.length) {
        const written = (await this.call("write", [
          fd,
          position + offset,
          vsBuffer(data),
          offset,
          data.length - offset,
        ])) as number;
        if (!Number.isInteger(written) || written <= 0 || written > data.length - offset) {
          throw new Error("malformed or zero-length remoteFilesystem write response");
        }
        offset += written;
      }
    });
  }

  public close(fd: number): Promise<void> {
    return this.withFd(fd, async () => {
      await this.call("close", [fd]);
      this.fdOperations.delete(fd);
    });
  }

  public async mkdir(path: string): Promise<void> {
    await this.call("mkdir", [this.uri(path)]);
  }

  public async delete(path: string, recursive = false): Promise<void> {
    await this.call("delete", [this.uri(path), { recursive, useTrash: false, atomic: false }]);
  }

  public async rename(source: string, destination: string, overwrite = false): Promise<void> {
    await this.call("rename", [this.uri(source), this.uri(destination), { overwrite }]);
  }

  public async copy(source: string, destination: string, overwrite = false): Promise<void> {
    await this.call("copy", [this.uri(source), this.uri(destination), { overwrite }]);
  }

  private uri(path: string): UriComponents {
    return {
      $mid: 1,
      scheme: "vscode-remote",
      authority: this.remoteAuthority,
      path,
    };
  }

  private call(command: string, argument: unknown): Promise<unknown> {
    return this.ipc.call("remoteFilesystem", command, argument);
  }

  private async withFd<T>(fd: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.fdOperations.get(fd) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.fdOperations.set(fd, previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
