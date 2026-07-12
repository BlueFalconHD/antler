import { describe, expect, it } from "vitest";
import {
  normalizeRelativePath,
  relativeRemotePath,
  remotePath,
  validateRemoteRoot,
} from "../src/sync/paths.js";

describe("sync path confinement", () => {
  it.each(["../escape", "a/../../escape", "/absolute", "a\\b", "a\0b", ".git/config", ".moose_proxy/state.json"])(
    "rejects %s",
    (candidate) => expect(() => normalizeRelativePath(candidate)).toThrow(),
  );

  it("maps safe relative paths under the configured root", () => {
    expect(remotePath("/srv/project", "src/main.ts")).toBe("/srv/project/src/main.ts");
    expect(relativeRemotePath("/srv/project", "/srv/project/src/main.ts")).toBe("src/main.ts");
  });

  it("rejects watcher paths outside the root and malformed roots", () => {
    expect(() => relativeRemotePath("/srv/project", "/srv/other/file")).toThrow(/escapes/);
    expect(() => validateRemoteRoot("relative")).toThrow();
    expect(() => validateRemoteRoot("/srv/../etc")).toThrow();
  });
});
