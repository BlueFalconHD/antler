import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StagedFile } from "../src/sftp/stagedFile.js";
import { RemoteRpcError } from "../src/vscode/ipcClient.js";
import { FileType, type RemoteFileSystemClient, type RemoteStat } from "../src/vscode/remoteFileSystem.js";

class MemoryRemote {
  public readonly files = new Map<string, Buffer>();
  private readonly descriptors = new Map<number, { path: string; writable: boolean }>();
  private nextDescriptor = 1;

  public async stat(filePath: string): Promise<RemoteStat> {
    const value = this.files.get(filePath);
    if (!value) {
      throw new RemoteRpcError("missing", "EntryNotFound (FileSystemError)");
    }
    return { type: FileType.File, ctime: 1, mtime: 1, size: value.length };
  }

  public async openRead(filePath: string): Promise<number> {
    await this.stat(filePath);
    const descriptor = this.nextDescriptor++;
    this.descriptors.set(descriptor, { path: filePath, writable: false });
    return descriptor;
  }

  public async openWriteTruncate(filePath: string): Promise<number> {
    this.files.set(filePath, Buffer.alloc(0));
    const descriptor = this.nextDescriptor++;
    this.descriptors.set(descriptor, { path: filePath, writable: true });
    return descriptor;
  }

  public async read(descriptor: number, position: number, length: number): Promise<Buffer> {
    const entry = this.descriptors.get(descriptor)!;
    return this.files.get(entry.path)!.subarray(position, position + length);
  }

  public async write(descriptor: number, position: number, data: Buffer): Promise<void> {
    const entry = this.descriptors.get(descriptor)!;
    if (!entry.writable) {
      throw new Error("read-only descriptor");
    }
    const current = this.files.get(entry.path)!;
    const output = Buffer.alloc(Math.max(current.length, position + data.length));
    current.copy(output);
    data.copy(output, position);
    this.files.set(entry.path, output);
  }

  public async close(descriptor: number): Promise<void> {
    this.descriptors.delete(descriptor);
  }

  public async rename(source: string, destination: string, overwrite: boolean): Promise<void> {
    if (!overwrite && this.files.has(destination)) {
      throw new Error("exists");
    }
    this.files.set(destination, this.files.get(source)!);
    this.files.delete(source);
  }

  public async delete(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function stagingDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moose-proxy-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("staged offset writes", () => {
  it("preserves existing data around an offset-based write", async () => {
    const remote = new MemoryRemote();
    remote.files.set("/root/file.txt", Buffer.from("abcdef"));
    let released = false;
    const file = await StagedFile.create({
      remote: remote as unknown as RemoteFileSystemClient,
      remotePath: "/root/file.txt",
      stagingDirectory: await stagingDirectory(),
      existingStat: await remote.stat("/root/file.txt"),
      preserveExisting: true,
      append: false,
      releaseLock: () => {
        released = true;
      },
      verifyConfinement: async () => undefined,
    });
    await file.write(2, Buffer.from("ZZ"));
    expect((await file.read(0, 10)).toString()).toBe("abZZef");
    await file.commit();
    expect(remote.files.get("/root/file.txt")?.toString()).toBe("abZZef");
    expect(released).toBe(true);
  });

  it("supports truncate through the staged representation", async () => {
    const remote = new MemoryRemote();
    remote.files.set("/root/file.txt", Buffer.from("abcdef"));
    const file = await StagedFile.create({
      remote: remote as unknown as RemoteFileSystemClient,
      remotePath: "/root/file.txt",
      stagingDirectory: await stagingDirectory(),
      existingStat: await remote.stat("/root/file.txt"),
      preserveExisting: true,
      append: false,
      releaseLock: () => undefined,
      verifyConfinement: async () => undefined,
    });
    await file.truncate(3);
    await file.commit();
    expect(remote.files.get("/root/file.txt")?.toString()).toBe("abc");
  });

  it("aborts without mutating the remote file", async () => {
    const remote = new MemoryRemote();
    remote.files.set("/root/file.txt", Buffer.from("original"));
    const file = await StagedFile.create({
      remote: remote as unknown as RemoteFileSystemClient,
      remotePath: "/root/file.txt",
      stagingDirectory: await stagingDirectory(),
      existingStat: await remote.stat("/root/file.txt"),
      preserveExisting: false,
      append: false,
      releaseLock: () => undefined,
      verifyConfinement: async () => undefined,
    });
    await file.write(0, Buffer.from("replacement"));
    await file.abort();
    expect(remote.files.get("/root/file.txt")?.toString()).toBe("original");
  });
});
