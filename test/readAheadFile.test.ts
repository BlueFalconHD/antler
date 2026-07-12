import { describe, expect, it } from "vitest";
import { ReadAheadFile } from "../src/sftp/readAheadFile.js";
import type { RemoteFileSystemClient } from "../src/vscode/remoteFileSystem.js";

const WINDOW = 1024 * 1024;

class MemoryRemote {
  public readCalls = 0;
  public closeCalls = 0;

  public constructor(
    private readonly data: Buffer,
    private readonly maximumRead = Number.MAX_SAFE_INTEGER,
  ) {}

  public async read(_fd: number, position: number, length: number): Promise<Buffer> {
    this.readCalls += 1;
    const count = Math.min(length, this.maximumRead);
    return this.data.subarray(position, position + count);
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("remote read-ahead", () => {
  it("coalesces concurrent small reads in the same one-megabyte window", async () => {
    const data = Buffer.alloc(WINDOW, 0x61);
    const remote = new MemoryRemote(data);
    const file = new ReadAheadFile(remote as unknown as RemoteFileSystemClient, 1, data.length);
    const chunks = await Promise.all([
      file.read(0, 32 * 1024),
      file.read(32 * 1024, 32 * 1024),
      file.read(64 * 1024, 32 * 1024),
    ]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([32 * 1024, 32 * 1024, 32 * 1024]);
    expect(remote.readCalls).toBe(1);
    await file.close();
    expect(remote.closeCalls).toBe(1);
  });

  it("fetches a second window only when an offset crosses its boundary", async () => {
    const data = Buffer.alloc(WINDOW * 2, 0x62);
    const remote = new MemoryRemote(data);
    const file = new ReadAheadFile(remote as unknown as RemoteFileSystemClient, 1, data.length);
    expect(await file.read(WINDOW - 16, 32)).toHaveLength(32);
    expect(remote.readCalls).toBe(2);
    expect(await file.read(WINDOW + 128, 64)).toHaveLength(64);
    expect(remote.readCalls).toBe(2);
    await file.close();
  });

  it("fills a cache window across partial remote reads and stops at known EOF", async () => {
    const data = Buffer.alloc(256 * 1024, 0x63);
    const remote = new MemoryRemote(data, 64 * 1024);
    const file = new ReadAheadFile(remote as unknown as RemoteFileSystemClient, 1, data.length);
    expect(await file.read(0, 128 * 1024)).toHaveLength(128 * 1024);
    expect(remote.readCalls).toBe(4);
    expect(await file.read(data.length, 1024)).toHaveLength(0);
    expect(remote.readCalls).toBe(4);
    await file.close();
  });
});
