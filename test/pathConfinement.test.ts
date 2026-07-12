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
});
