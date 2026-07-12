import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "./errors.js";
import { FileType, type RemoteFileSystemClient, type RemoteStat } from "../vscode/remoteFileSystem.js";

const TRANSFER_CHUNK = 1024 * 1024;

export interface StagedFileOptions {
  readonly remote: RemoteFileSystemClient;
  readonly remotePath: string;
  readonly stagingDirectory: string;
  readonly existingStat: RemoteStat | undefined;
  readonly preserveExisting: boolean;
  readonly append: boolean;
  readonly releaseLock: () => void;
  readonly verifyConfinement: () => Promise<void>;
}

export class StagedFile {
  private closed = false;
  private operationChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly remote: RemoteFileSystemClient,
    public readonly remotePath: string,
    private readonly localPath: string,
    private readonly local: FileHandle,
    private readonly existedAtOpen: boolean,
    private readonly append: boolean,
    private readonly releaseLock: () => void,
    private readonly verifyConfinement: () => Promise<void>,
  ) {}

  public static async create(options: StagedFileOptions): Promise<StagedFile> {
    await fs.mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
    const stagingStat = await fs.lstat(options.stagingDirectory);
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
      throw new Error("staging path must be a non-symlink directory");
    }
    if (process.platform !== "win32" && (stagingStat.mode & 0o077) !== 0) {
      throw new Error("staging directory permissions must not allow group or other access");
    }
    const localPath = path.join(options.stagingDirectory, `${randomUUID()}.stage`);
    const local = await fs.open(localPath, "wx+", 0o600);
    const staged = new StagedFile(
      options.remote,
      options.remotePath,
      localPath,
      local,
      options.existingStat !== undefined,
      options.append,
      options.releaseLock,
      options.verifyConfinement,
    );
    try {
      if (options.preserveExisting && options.existingStat) {
        await staged.download();
      }
      return staged;
    } catch (error) {
      await staged.abort();
      throw error;
    }
  }

  public async read(position: number, length: number): Promise<Buffer> {
    this.ensureOpen();
    return this.enqueue(async () => {
      const output = Buffer.alloc(length);
      const { bytesRead } = await this.local.read(output, 0, length, position);
      return output.subarray(0, bytesRead);
    });
  }

  public async write(position: number, data: Buffer): Promise<void> {
    this.ensureOpen();
    await this.enqueue(async () => {
      let offset = 0;
      const target = this.append ? (await this.local.stat()).size : position;
      while (offset < data.length) {
        const { bytesWritten } = await this.local.write(data, offset, data.length - offset, target + offset);
        if (bytesWritten <= 0) {
          throw new Error("local staging write made no progress");
        }
        offset += bytesWritten;
      }
    });
  }

  public async stat(): Promise<{ size: number; mtimeMs: number; ctimeMs: number }> {
    this.ensureOpen();
    return this.enqueue(async () => {
      const stat = await this.local.stat();
      return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.birthtimeMs };
    });
  }

  public async truncate(size: number): Promise<void> {
    this.ensureOpen();
    await this.enqueue(() => this.local.truncate(size));
  }

  public async commit(): Promise<void> {
    this.ensureOpen();
    this.closed = true;
    await this.operationChain;
    let temporaryRemotePath: string | undefined;
    try {
      await this.local.sync();
      await this.verifyConfinement();
      temporaryRemotePath = await this.chooseRemoteTemporaryPath();
      const remoteFd = await this.remote.openWriteTruncate(temporaryRemotePath);
      try {
        let position = 0;
        while (true) {
          const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK);
          const { bytesRead } = await this.local.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) {
            break;
          }
          await this.remote.write(remoteFd, position, buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
      } finally {
        await this.remote.close(remoteFd);
      }

      await this.verifyConfinement();
      if (!this.existedAtOpen) {
        try {
          await this.remote.stat(this.remotePath);
          throw new Error("destination was created while SFTP write handle was open");
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      } else {
        const current = await this.remote.stat(this.remotePath);
        if ((current.type & FileType.File) === 0 || (current.type & FileType.SymbolicLink) !== 0) {
          throw new Error("destination changed type while SFTP write handle was open");
        }
      }
      await this.remote.rename(temporaryRemotePath, this.remotePath, this.existedAtOpen);
      temporaryRemotePath = undefined;
    } finally {
      if (temporaryRemotePath) {
        try {
          await this.remote.delete(temporaryRemotePath, false);
        } catch {
          // Best-effort rollback; original operation error is authoritative.
        }
      }
      await this.disposeLocal();
      this.releaseLock();
    }
  }

  public async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.operationChain;
    await this.disposeLocal();
    this.releaseLock();
  }

  private async download(): Promise<void> {
    const remoteFd = await this.remote.openRead(this.remotePath);
    try {
      let position = 0;
      while (true) {
        const buffer = await this.remote.read(remoteFd, position, TRANSFER_CHUNK);
        if (buffer.length === 0) {
          break;
        }
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await this.local.write(buffer, offset, buffer.length - offset, position + offset);
          if (bytesWritten <= 0) {
            throw new Error("local staging download made no progress");
          }
          offset += bytesWritten;
        }
        position += buffer.length;
      }
    } finally {
      await this.remote.close(remoteFd);
    }
  }

  private async chooseRemoteTemporaryPath(): Promise<string> {
    const directory = path.posix.dirname(this.remotePath);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = path.posix.join(directory, `.moose-proxy-${randomUUID()}.tmp`);
      try {
        await this.remote.stat(candidate);
      } catch (error) {
        if (isNotFound(error)) {
          return candidate;
        }
        throw error;
      }
    }
    throw new Error("unable to allocate a remote staging name");
  }

  private async disposeLocal(): Promise<void> {
    try {
      await this.local.close();
    } finally {
      await fs.rm(this.localPath, { force: true });
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("staged file is closed");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
