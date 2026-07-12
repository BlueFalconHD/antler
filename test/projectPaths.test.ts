import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectConfig } from "../src/projectConfig.js";
import {
  assertSafeProjectPaths,
  configuredSyncRoot,
  normalizeConfiguredSyncRoot,
  resolveProjectPaths,
} from "../src/projectPaths.js";

describe("project paths", () => {
  it("keeps persistent state at the project root while resolving a nested sync root", () => {
    const projectRoot = path.resolve("/tmp/antler-project");
    const config = createProjectConfig({
      url: new URL("https://code.example.test/"),
      remoteRoot: "/srv/datapack",
      syncRoot: "dist/datapack",
    });

    expect(resolveProjectPaths(projectRoot, config)).toEqual({
      projectRoot,
      stateDirectory: path.join(projectRoot, ".antler"),
      syncRoot: path.join(projectRoot, "dist", "datapack"),
    });
  });

  it("normalizes command paths to portable project-relative configuration", () => {
    const projectRoot = path.resolve("/tmp/antler-project");
    expect(configuredSyncRoot(projectRoot, path.join(projectRoot, "dist", "pack"))).toBe("dist/pack");
    expect(configuredSyncRoot(projectRoot, ".")).toBe(".");
  });

  it("rejects absolute, parent, and platform-specific configured roots", () => {
    for (const invalid of ["/tmp/dist", "../dist", "a/../../dist", "C:\\dist", "dist\\pack", ""]) {
      expect(() => normalizeConfiguredSyncRoot(invalid)).toThrow();
    }
  });

  it.runIf(process.platform !== "win32")("rejects a nested root that resolves through a symlink outside the project", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "antler-paths-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "antler-paths-outside-"));
    try {
      await fs.symlink(outside, path.join(projectRoot, "dist"));
      const config = createProjectConfig({
        url: new URL("https://code.example.test/"),
        remoteRoot: "/srv/datapack",
        syncRoot: "dist",
      });
      await expect(assertSafeProjectPaths(resolveProjectPaths(projectRoot, config))).rejects.toThrow(
        /non-symlink|outside/,
      );
    } finally {
      await Promise.all([
        fs.rm(projectRoot, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
