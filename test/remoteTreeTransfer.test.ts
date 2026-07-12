import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentManager } from "../src/remoteAgentManager.js";
import { RemoteTree } from "../src/sync/remoteTree.js";
import { LARGE_FILE_THRESHOLD_BYTES, TRANSFER_CHUNK_BYTES } from "../src/sync/transferPolicy.js";
import { FileType, type RemoteFileSystemClient, type RemoteStat } from "../src/vscode/remoteFileSystem.js";

describe("remote tree large transfers", () => {
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
