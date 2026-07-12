import { describe, expect, it } from "vitest";
import { PathConfinement, validateClientPath } from "../src/confinement/pathConfinement.js";
import { RemoteRpcError } from "../src/vscode/ipcClient.js";
import { FileType, type RemoteFileSystemClient, type RemoteStat } from "../src/vscode/remoteFileSystem.js";

const directory: RemoteStat = { type: FileType.Directory, ctime: 1, mtime: 1, size: 0 };
const file: RemoteStat = { type: FileType.File, ctime: 1, mtime: 1, size: 1 };

function remote(stats: Record<string, RemoteStat>): RemoteFileSystemClient {
  return {
    stat: async (path: string) => {
      const value = stats[path];
      if (!value) {
        throw new RemoteRpcError("missing", "EntryNotFound (FileSystemError)");
      }
      return value;
    },
  } as unknown as RemoteFileSystemClient;
}

function countingRemote(stats: Record<string, RemoteStat>, calls: string[]): RemoteFileSystemClient {
  return {
    stat: async (remotePath: string) => {
      calls.push(remotePath);
      const value = stats[remotePath];
      if (!value) {
        throw new RemoteRpcError("missing", "EntryNotFound (FileSystemError)");
      }
      return value;
    },
  } as unknown as RemoteFileSystemClient;
}

describe("path confinement", () => {
  it("maps the virtual root to the configured remote root", () => {
    const confinement = new PathConfinement("/srv/work", remote({}));
    expect(confinement.map("/")).toEqual({ clientPath: "/", remotePath: "/srv/work" });
    expect(confinement.map("/src/main.ts")).toEqual({
      clientPath: "/src/main.ts",
      remotePath: "/srv/work/src/main.ts",
    });
  });

  it.each(["../escape", "/a/../../escape", "a\\..\\escape", "a\0b"])("rejects malicious path %s", (value) => {
    expect(() => validateClientPath(value)).toThrow();
  });

  it("rejects symlink components", async () => {
    const confinement = new PathConfinement(
      "/srv/work",
      remote({
        "/": directory,
        "/srv": directory,
        "/srv/work": directory,
        "/srv/work/link": { ...directory, type: FileType.Directory | FileType.SymbolicLink },
        "/srv/work/link/file": file,
      }),
    );
    await expect(confinement.existing("/link/file")).rejects.toThrow(/Symbolic links/);
  });

  it("allows only a missing final component for creation", async () => {
    const confinement = new PathConfinement(
      "/srv/work",
      remote({ "/": directory, "/srv": directory, "/srv/work": directory, "/srv/work/dir": directory }),
    );
    await expect(confinement.forCreate("/dir/new.txt")).resolves.toMatchObject({ remotePath: "/srv/work/dir/new.txt" });
    await expect(confinement.forCreate("/missing/new.txt")).rejects.toThrow();
  });

  it("verifies root ancestors once but checks only components inside the root during operations", async () => {
    const calls: string[] = [];
    const confinement = new PathConfinement(
      "/home/coder/project",
      countingRemote(
        {
          "/": directory,
          "/home": directory,
          "/home/coder": directory,
          "/home/coder/project": directory,
          "/home/coder/project/data": directory,
          "/home/coder/project/data/file.txt": file,
        },
        calls,
      ),
    );
    await confinement.verifyRoot();
    expect(calls).toEqual(["/", "/home", "/home/coder", "/home/coder/project"]);
    calls.length = 0;
    await confinement.existing("/data/file.txt");
    expect(calls).toEqual([
      "/home/coder/project",
      "/home/coder/project/data",
      "/home/coder/project/data/file.txt",
    ]);
  });

  it("stats only the child after its directory was verified", async () => {
    const calls: string[] = [];
    const confinement = new PathConfinement(
      "/home/coder/project",
      countingRemote(
        {
          "/home/coder/project": directory,
          "/home/coder/project/file.txt": file,
        },
        calls,
      ),
    );
    const parent = await confinement.existing("/");
    calls.length = 0;
    await expect(confinement.childOfVerifiedDirectory(parent, "file.txt")).resolves.toMatchObject({
      clientPath: "/file.txt",
      remotePath: "/home/coder/project/file.txt",
    });
    expect(calls).toEqual(["/home/coder/project/file.txt"]);
    await expect(confinement.childOfVerifiedDirectory(parent, "../escape")).rejects.toThrow(/Parent traversal/);
  });
});
