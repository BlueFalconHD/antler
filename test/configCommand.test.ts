import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDeletePolicy } from "../src/commands/config.js";
import { Logger } from "../src/logging.js";
import { createProjectConfig, loadProjectConfig, saveProjectConfig } from "../src/projectConfig.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("project configuration command", () => {
  it("changes an existing project's delete policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-config-command-"));
    roots.push(root);
    await saveProjectConfig(root, createProjectConfig({
      url: new URL("https://code.example.test/instance/"),
      remoteRoot: "/home/coder/project/datapack",
    }));

    await setDeletePolicy(root, "allow", new Logger("error", { format: "plain", color: false }));

    expect((await loadProjectConfig(root)).sync.deletePolicy).toBe("allow");
  });
});
