import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectConfig,
  findProjectRoot,
  loadProjectConfig,
  parseConnectionUrl,
} from "../src/projectConfig.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("Antler project configuration", () => {
  it("accepts the normal browser workspace URL and infers its remote root", () => {
    const parsed = parseConnectionUrl(
      "https://code.legitimoose.com/99c37226-0c25-4aff-81ee-e1562ac39a4f/" +
      "?folder=/home/coder/project/datapack",
    );

    expect(parsed.baseUrl.toString()).toBe(
      "https://code.legitimoose.com/99c37226-0c25-4aff-81ee-e1562ac39a4f/",
    );
    expect(parsed.remoteRoot).toBe("/home/coder/project/datapack");
  });

  it("continues to accept a login URL and rejects unrelated base URL queries", () => {
    const parsed = parseConnectionUrl(
      "https://code.example.test/deployment/login?folder=/home/coder/project/datapack&to=",
    );

    expect(parsed.baseUrl.toString()).toBe("https://code.example.test/deployment/");
    expect(parsed.remoteRoot).toBe("/home/coder/project/datapack");
    expect(() => parseConnectionUrl("https://code.example.test/deployment/?token=unsafe")).toThrow(
      /must include the remote folder parameter/,
    );
  });

  it("creates profile-free schema version 3 configuration", () => {
    const config = createProjectConfig({
      url: new URL("https://code.example.test/deployment/"),
      remoteRoot: "/home/coder/project/datapack",
      syncRoot: "dist/datapack",
    });
    expect(config.schemaVersion).toBe(3);
    expect(config.local.root).toBe("dist/datapack");
    expect(config.remote).not.toHaveProperty("profile");
    expect(config.sync.concurrency).toBe(32);
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
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.local.root).toBe(".");
    expect(migrated.remote).not.toHaveProperty("profile");
    const persisted = JSON.parse(await fs.readFile(path.join(root, ".antler", "config.json"), "utf8")) as object;
    expect(persisted).toMatchObject({ schemaVersion: 3, local: { root: "." } });
    expect((persisted as { remote: object }).remote).not.toHaveProperty("profile");
  });

  it("migrates schema version 2 with the former local-root behavior", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-config-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".antler"));
    await fs.writeFile(path.join(root, ".antler", "config.json"), JSON.stringify(versionTwoConfig()));

    const migrated = await loadProjectConfig(root);

    expect(migrated).toMatchObject({ schemaVersion: 3, local: { root: "." } });
    const persisted = JSON.parse(await fs.readFile(path.join(root, ".antler", "config.json"), "utf8")) as object;
    expect(persisted).toMatchObject({ schemaVersion: 3, local: { root: "." } });
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

function versionTwoConfig(): object {
  const { remote, sync, safety, git } = legacyConfig() as {
    remote: Record<string, unknown>;
    sync: object;
    safety: object;
    git: object;
  };
  const profileFreeRemote = { ...remote };
  delete profileFreeRemote.profile;
  return {
    schemaVersion: 2,
    projectId: "version-two-project",
    remote: profileFreeRemote,
    sync,
    safety,
    git,
  };
}
