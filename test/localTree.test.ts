import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTree } from "../src/sync/localTree.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("local tree", () => {
  it("atomically writes files and hard-excludes sync and Git state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-local-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, ".moose_proxy"));
    const tree = new LocalTree({ root });
    await tree.initialize();
    await tree.mkdir("src");
    await tree.writeFileAtomic("src/main.ts", Buffer.from("hello"));
    expect((await tree.readFile("src/main.ts")).toString()).toBe("hello");
    expect([...await tree.scan().then((entries) => entries.keys())]).toEqual(["src", "src/main.ts"]);
  });

  it("refuses symlinks in the scanned tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-local-"));
    roots.push(root);
    await fs.symlink(os.tmpdir(), path.join(root, "escape"));
    const tree = new LocalTree({ root });
    await tree.initialize();
    await expect(tree.scan()).rejects.toThrow(/Symbolic links/);
  });
});
