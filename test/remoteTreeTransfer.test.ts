import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentManager } from "../src/remoteAgentManager.js";
import { RemoteTree } from "../src/sync/remoteTree.js";
import { LARGE_FILE_THRESHOLD_BYTES, TRANSFER_CHUNK_BYTES } from "../src/sync/transferPolicy.js";
import { FileType, type RemoteFileSystemClient, type RemoteStat } from "../src/vscode/remoteFileSystem.js";

describe("remote tree large transfers", () => {
  it("scans sibling directories concurrently through one global limit", async () => {
    let activeDirectoryReads = 0;
    let maximumDirectoryReads = 0;
    const directory: RemoteStat = { type: FileType.Directory, ctime: 1, mtime: 1, size: 0 };
    const client = {
      readdir: vi.fn(async (absolutePath: string) => {
        if (absolutePath === "/srv/project") {
          return ["a", "b", "c", "d"].map((name) => ({ name, type: FileType.Directory }));
        }
        activeDirectoryReads += 1;
        maximumDirectoryReads = Math.max(maximumDirectoryReads, activeDirectoryReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDirectoryReads -= 1;
        return [];
      }),
      stat: vi.fn(async () => directory),
    } as unknown as RemoteFileSystemClient;
    const tree = new RemoteTree({ manager: fakeManager(client), root: "/srv/project", concurrency: 4 });

    await expect(tree.scan()).resolves.toHaveProperty("size", 4);
    expect(maximumDirectoryReads).toBe(4);
  });

  it("reuses a scan-verified entry instead of restating every parent before reading", async () => {
    const directory: RemoteStat = { type: FileType.Directory, ctime: 1, mtime: 1, size: 0 };
    const file: RemoteStat = { type: FileType.File, ctime: 2, mtime: 2, size: 5 };
    const client = {
      readdir: vi.fn(async (absolutePath: string) => absolutePath === "/srv/project"
        ? [{ name: "nested", type: FileType.Directory }]
        : [{ name: "file.txt", type: FileType.File }]),
      stat: vi.fn(async (absolutePath: string) => absolutePath.endsWith("file.txt") ? file : directory),
      readFile: vi.fn(async () => Buffer.from("hello")),
    } as unknown as RemoteFileSystemClient;
    const tree = new RemoteTree({ manager: fakeManager(client), root: "/srv/project" });
    const entries = await tree.scan();
    const expected = entries.get("nested/file.txt");
    const scanStatCalls = (client.stat as ReturnType<typeof vi.fn>).mock.calls.length;

    await expect(tree.readFile("nested/file.txt", undefined, expected)).resolves.toEqual(Buffer.from("hello"));
    expect(client.stat).toHaveBeenCalledTimes(scanStatCalls);
    expect(client.readFile).toHaveBeenCalledTimes(1);
  });

  it("uses offset reads when progress is requested for a large file", async () => {
    const content = Buffer.alloc(LARGE_FILE_THRESHOLD_BYTES, 7);
    const client = fakeClient(content.length);
    client.readFileChunked = vi.fn().mockResolvedValue(content);
    client.readFile = vi.fn();
    const tree = new RemoteTree({ manager: fakeManager(client), root: "/srv/project" });
    const progress = vi.fn();

    const result = await tree.readFile("large.bin", progress);
    expect(result).toBe(content);
    expect(client.readFileChunked).toHaveBeenCalledWith(
      "/srv/project/large.bin",
      content.length,
      TRANSFER_CHUNK_BYTES,
      progress,
    );
    expect(client.readFile).not.toHaveBeenCalled();
  });

  it("chunks a large upload into the atomic staging file", async () => {
    const content = Buffer.alloc(LARGE_FILE_THRESHOLD_BYTES, 9);
    const client = fakeClient(content.length);
    client.writeFileChunked = vi.fn().mockResolvedValue(undefined);
    client.writeFile = vi.fn();
    client.rename = vi.fn().mockResolvedValue(undefined);
    const manager = fakeManager(client);
    const tree = new RemoteTree({ manager, root: "/srv/project" });
    const progress = vi.fn();

    await expect(tree.writeFileAtomic("large.bin", content, progress)).resolves.toMatchObject({
      path: "large.bin",
      size: content.length,
    });
    expect(client.writeFileChunked).toHaveBeenCalledWith(
      expect.stringMatching(/^\/srv\/project\/\.antler-tmp-/),
      expect.any(Buffer),
      TRANSFER_CHUNK_BYTES,
      progress,
    );
    expect((client.writeFileChunked as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(content);
    expect(client.writeFile).not.toHaveBeenCalled();
    expect(client.rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/srv\/project\/\.antler-tmp-/),
      "/srv/project/large.bin",
      true,
    );
    expect(manager.assertGeneration).toHaveBeenCalledWith(1);
  });
});

function fakeClient(size: number): RemoteFileSystemClient & Record<string, ReturnType<typeof vi.fn>> {
  const directory: RemoteStat = { type: FileType.Directory, ctime: 1, mtime: 1, size: 0 };
  const file: RemoteStat = { type: FileType.File, ctime: 1, mtime: 1, size };
  return {
    stat: vi.fn(async (absolutePath: string) => absolutePath === "/srv/project" ? directory : file),
    delete: vi.fn(),
  } as unknown as RemoteFileSystemClient & Record<string, ReturnType<typeof vi.fn>>;
}

function fakeManager(client: RemoteFileSystemClient): RemoteAgentManager & { assertGeneration: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => ({ client, generation: 1 })),
    assertGeneration: vi.fn(),
  } as unknown as RemoteAgentManager & { assertGeneration: ReturnType<typeof vi.fn> };
}
