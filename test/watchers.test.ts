import path from "node:path";
import { describe, expect, it } from "vitest";
import { localWatchPath } from "../src/sync/watchers.js";

describe("local watcher path handling", () => {
  const root = path.resolve("/private/tmp/antler-watch-root");

  it.each([
    ".git",
    ".git/index",
    ".antler/state.json",
    ".moose_proxy/state.json",
    path.join(root, ".git", "index"),
    path.join(root, ".antler", "state.json"),
    path.join(root, ".moose_proxy", "state.json"),
    path.join(root, "src", ".antler-tmp-upload"),
    path.join(root, "src", ".moose_proxy-tmp-upload"),
  ])("silently drops reserved watcher events: %s", (candidate) => {
    expect(localWatchPath(root, candidate)).toBeUndefined();
  });

  it("accepts relative, absolute, and buffer event names inside the root", () => {
    expect(localWatchPath(root, "src/main.ts")).toBe("src/main.ts");
    expect(localWatchPath(root, path.join(root, "src", "main.ts"))).toBe("src/main.ts");
    expect(localWatchPath(root, Buffer.from("README.md"))).toBe("README.md");
  });

  it("rejects absolute watcher names outside the configured root", () => {
    expect(() => localWatchPath(root, "/private/tmp/other/file.txt")).toThrow(/escapes/);
  });

  it.each(["../escape", "src\\ambiguous.txt", "bad\0name"])(
    "continues to reject malformed ordinary paths: %s",
    (candidate) => expect(() => localWatchPath(root, candidate)).toThrow(),
  );

  it("normalizes Windows watcher names and drive-letter casing", () => {
    const windowsRoot = "C:\\Users\\Moose\\Pack";
    expect(localWatchPath(windowsRoot, "data\\example.json", "win32")).toBe("data/example.json");
    expect(localWatchPath(windowsRoot, "c:\\users\\moose\\pack\\data\\example.json", "win32"))
      .toBe("data/example.json");
    expect(localWatchPath(windowsRoot, "C:\\Users\\Moose\\Pack\\.antler\\state.json", "win32"))
      .toBeUndefined();
  });

  it("rejects Windows watcher paths outside the root", () => {
    const windowsRoot = "C:\\Users\\Moose\\Pack";
    expect(() => localWatchPath(windowsRoot, "D:\\Other\\example.json", "win32")).toThrow(/escapes/);
    expect(() => localWatchPath(windowsRoot, "C:\\Users\\Moose\\Other\\example.json", "win32"))
      .toThrow(/escapes/);
  });
});
