import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IgnoreRules } from "../src/sync/ignoreRules.js";

describe("sync ignore rules", () => {
  it("does not apply a parent Git ignore rule that excludes the sync root", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "antler-ignore-"));
    try {
      const syncRoot = path.join(projectRoot, "dist");
      await fs.mkdir(syncRoot);
      await fs.writeFile(path.join(projectRoot, ".gitignore"), "dist/\n");

      const rules = await IgnoreRules.load(syncRoot, []);

      expect(rules.ignores("pack.mcmeta", false)).toBe(false);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
