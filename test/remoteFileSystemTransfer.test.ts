import { describe, expect, it, vi } from "vitest";
import type { IpcClient } from "../src/vscode/ipcClient.js";
import { VSBufferValue } from "../src/vscode/serialization.js";
import { RemoteFileSystemClient } from "../src/vscode/remoteFileSystem.js";

describe("remoteFilesystem chunked transfers", () => {
  it("reads by offset with byte-accurate progress and closes the handle", async () => {
    const source = Buffer.from("abcdefghij");
    const operations: string[] = [];
    const ipc = {
      call: async (_channel: string, command: string, argument: unknown) => {
        operations.push(command);
        if (command === "open") return 7;
        if (command === "read") {
          const [, position, length] = argument as [number, number, number];
          const chunk = source.subarray(position, position + length);
          return [chunk, chunk.length];
        }
        return undefined;
      },
    } as unknown as IpcClient;
    const progress = vi.fn();
    const client = new RemoteFileSystemClient(ipc, "example.test");

    await expect(client.readFileChunked("/large.bin", source.length, 4, progress)).resolves.toEqual(source);
    expect(progress.mock.calls).toEqual([[0, 10], [4, 10], [8, 10], [10, 10]]);
    expect(operations).toEqual(["open", "read", "read", "read", "close"]);
  });

  it("writes sequential chunks and reports real acknowledged bytes", async () => {
    const writes: Array<{ position: number; content: string }> = [];
    const operations: string[] = [];
    const ipc = {
      call: async (_channel: string, command: string, argument: unknown) => {
        operations.push(command);
        if (command === "open") return 9;
        if (command === "write") {
          const [, position, value, offset, length] = argument as [number, number, VSBufferValue, number, number];
          writes.push({ position, content: value.buffer.subarray(offset, offset + length).toString() });
          return length;
        }
        return undefined;
      },
    } as unknown as IpcClient;
    const progress = vi.fn();
    const client = new RemoteFileSystemClient(ipc, "example.test");

    await client.writeFileChunked("/large.bin", Buffer.from("abcdefghij"), 4, progress);
    expect(writes).toEqual([
      { position: 0, content: "abcd" },
      { position: 4, content: "efgh" },
      { position: 8, content: "ij" },
    ]);
    expect(progress.mock.calls).toEqual([[0, 10], [4, 10], [8, 10], [10, 10]]);
    expect(operations).toEqual(["open", "write", "write", "write", "close"]);
  });

  it("closes the handle when a chunk operation fails", async () => {
    const operations: string[] = [];
    const ipc = {
      call: async (_channel: string, command: string) => {
        operations.push(command);
        if (command === "open") return 11;
        if (command === "read") throw new Error("connection lost");
        return undefined;
      },
    } as unknown as IpcClient;
    const client = new RemoteFileSystemClient(ipc, "example.test");

    await expect(client.readFileChunked("/large.bin", 8, 4, () => undefined)).rejects.toThrow(/connection lost/);
    expect(operations).toEqual(["open", "read", "close"]);
  });
});
