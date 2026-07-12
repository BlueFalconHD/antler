import { describe, expect, it } from "vitest";
import {
  isHardExcluded,
  isLocalPathInside,
  localPath,
  normalizeLocalRelativePath,
  normalizeRelativePath,
  relativeRemotePath,
  remotePath,
  validateRemoteRoot,
} from "../src/sync/paths.js";

describe("sync path confinement", () => {
  it.each([
    "../escape",
    "a/../../escape",
    "/absolute",
    "a\\b",
    "a\0b",
    ".git/config",
    ".antler/state.json",
    ".moose_proxy/state.json",
  ])(
    "rejects %s",
    (candidate) => expect(() => normalizeRelativePath(candidate)).toThrow(),
  );

  it("maps safe relative paths under the configured root", () => {
    expect(remotePath("/srv/project", "src/main.ts")).toBe("/srv/project/src/main.ts");
    expect(relativeRemotePath("/srv/project", "/srv/project/src/main.ts")).toBe("src/main.ts");
  });

  it("maps and confines Windows local paths case-insensitively", () => {
    expect(localPath("C:\\Users\\Moose\\Pack", "data/example.json", "win32"))
      .toBe("C:\\Users\\Moose\\Pack\\data\\example.json");
    expect(isLocalPathInside("C:\\Users\\Moose\\Pack", "c:\\users\\moose\\pack\\data\\example.json", "win32"))
      .toBe(true);
    expect(isLocalPathInside("C:\\Users\\Moose\\Pack", "C:\\Users\\Moose\\Other\\example.json", "win32"))
      .toBe(false);
  });

  it.each([
    "CON",
    "data/aux.txt",
    "data/file:stream",
    "data/question?.json",
    "data/trailing.",
    "data/trailing ",
  ])("rejects Windows-incompatible local paths: %s", (candidate) => {
    expect(() => normalizeLocalRelativePath(candidate, "win32")).toThrow(/Windows/);
  });

  it("allows ordinary names containing Windows device-name prefixes", () => {
    expect(normalizeLocalRelativePath("data/console.json", "win32")).toBe("data/console.json");
    expect(normalizeLocalRelativePath("data/auxiliary.json", "win32")).toBe("data/auxiliary.json");
  });

  it("rejects watcher paths outside the root and malformed roots", () => {
    expect(() => relativeRemotePath("/srv/project", "/srv/other/file")).toThrow(/escapes/);
    expect(() => validateRemoteRoot("relative")).toThrow();
    expect(() => validateRemoteRoot("/srv/../etc")).toThrow();
  });

  it.each([
    ".git",
    ".git/index",
    ".GIT/config",
    ".antler/state.json",
    "/private/tmp/project/.antler/state.json",
    "/private/tmp/project/.moose_proxy/state.json",
    "C:\\project\\.git\\index",
    "src/.antler-tmp-upload",
    "src/.moose_proxy-tmp-upload",
  ])("recognizes reserved components before path normalization: %s", (candidate) => {
    expect(isHardExcluded(candidate)).toBe(true);
  });

  it.each(["src/main.ts", "/private/tmp/project/src/main.ts", "nested\\file.txt"])(
    "does not exclude ordinary paths: %s",
    (candidate) => expect(isHardExcluded(candidate)).toBe(false),
  );
});
