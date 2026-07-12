import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/sync/stateStore.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("durable sync state", () => {
  it("writes state atomically with private permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-state-"));
    roots.push(root);
    const store = new StateStore(path.join(root, ".antler"));
    await store.initialize("project");
    await store.recordJournal({ id: "operation", action: "upload", path: "a.txt", startedAt: "now" });
    const loaded = await new StateStore(path.join(root, ".antler")).load();
    expect(loaded.journal.operation?.path).toBe("a.txt");
    await store.commit((state) => {
      state.lastReconciledAt = "now";
    });
    expect(Object.keys((await new StateStore(path.join(root, ".antler")).load()).journal)).toHaveLength(0);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(root, ".antler"))).mode & 0o077).toBe(0);
      expect((await fs.stat(path.join(root, ".antler", "state.json"))).mode & 0o077).toBe(0);
    }
  });

  it("fails closed on malformed or missing state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-state-"));
    roots.push(root);
    const directory = path.join(root, ".antler");
    await fs.mkdir(directory);
    await expect(new StateStore(directory).load()).rejects.toThrow(/run antler init/);
    await fs.writeFile(path.join(directory, "state.json"), "{}");
    await expect(new StateStore(directory).load()).rejects.toThrow(/malformed/);
  });
});
