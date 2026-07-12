import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectConfig, findProjectRoot, loadProjectConfig } from "../src/projectConfig.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("Antler project configuration", () => {
  it("creates profile-free schema version 2 configuration", () => {
    const config = createProjectConfig({
      url: new URL("https://code.example.test/deployment/"),
      remoteRoot: "/home/coder/project/datapack",
    });
    expect(config.schemaVersion).toBe(2);
    expect(config.remote).not.toHaveProperty("profile");
  });

  it("atomically adopts legacy state and removes the legacy profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-config-"));
    roots.push(root);
    const legacy = path.join(root, ".moose_proxy");
    const child = path.join(root, "src");
    await Promise.all([fs.mkdir(legacy), fs.mkdir(child)]);
    await fs.writeFile(path.join(legacy, "config.json"), JSON.stringify(legacyConfig()));

    expect(await findProjectRoot(child)).toBe(root);
    await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(path.join(root, ".antler"))).isDirectory()).toBe(true);

    const migrated = await loadProjectConfig(root);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.remote).not.toHaveProperty("profile");
    const persisted = JSON.parse(await fs.readFile(path.join(root, ".antler", "config.json"), "utf8")) as object;
    expect(persisted).toMatchObject({ schemaVersion: 2 });
    expect((persisted as { remote: object }).remote).not.toHaveProperty("profile");
  });

  it("refuses to choose when current and legacy state both exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-config-"));
    roots.push(root);
    await Promise.all([
      fs.mkdir(path.join(root, ".antler")),
      fs.mkdir(path.join(root, ".moose_proxy")),
    ]);
    await expect(findProjectRoot(root)).rejects.toThrow(/Both .* exist/);
  });
});

function legacyConfig(): object {
  return {
    schemaVersion: 1,
    projectId: "legacy-project",
    remote: {
      url: "https://code.example.test/deployment/",
      root: "/home/coder/project/datapack",
      profile: "custom-v69",
      rejectUnauthorized: true,
      sendOrigin: true,
      allowVersionMismatch: false,
    },
    sync: {
      deletePolicy: "confirm",
      ignores: [],
      reconciliationIntervalSeconds: 30,
      debounceMilliseconds: 180,
      concurrency: 8,
    },
    safety: { maxDeletes: 20, maxDeletePercent: 10 },
    git: { enabled: true, checkpoints: true },
  };
}
