import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitCheckpoints } from "../src/git/checkpoints.js";
import { ObjectStore } from "../src/sync/objectStore.js";
import { StateStore } from "../src/sync/stateStore.js";
import { SyncEngine } from "../src/sync/syncEngine.js";
import type { TreeEndpoint, TreeEntry } from "../src/sync/types.js";

class MemoryTree implements TreeEndpoint {
  private clock = 1;
  private readonly values = new Map<string, { kind: "file" | "directory"; content?: Buffer; revision: number }>();
  public failNextWrite = false;
  public failAfterWrite = false;

  public constructor(public readonly side: "local" | "remote") {}

  public seedFile(path: string, value: string): void {
    this.values.set(path, { kind: "file", content: Buffer.from(value), revision: this.clock++ });
  }
  public seedDirectory(path: string): void {
    this.values.set(path, { kind: "directory", revision: this.clock++ });
  }
  public remove(path: string): void { this.values.delete(path); }
  public text(path: string): string | undefined { return this.values.get(path)?.content?.toString(); }

  public async scan(): Promise<Map<string, TreeEntry>> {
    return new Map([...this.values.keys()].sort().map((key) => [key, this.entry(key)!]));
  }
  public async stat(path: string): Promise<TreeEntry | undefined> { return this.entry(path); }
  public async readFile(path: string): Promise<Buffer> {
    const value = this.values.get(path);
    if (!value?.content) throw new Error("missing");
    return Buffer.from(value.content);
  }
  public async writeFileAtomic(path: string, content: Buffer): Promise<TreeEntry> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected write failure");
    }
    this.values.set(path, { kind: "file", content: Buffer.from(content), revision: this.clock++ });
    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new Error("injected lost acknowledgement");
    }
    return this.entry(path)!;
  }
  public async mkdir(path: string): Promise<TreeEntry> {
    this.seedDirectory(path);
    return this.entry(path)!;
  }
  public async delete(path: string): Promise<void> { this.values.delete(path); }
  public async rename(source: string, destination: string): Promise<TreeEntry> {
    const value = this.values.get(source);
    if (!value || this.values.has(destination)) throw new Error("invalid rename");
    this.values.delete(source);
    this.values.set(destination, { ...value, revision: this.clock++ });
    return this.entry(destination)!;
  }

  private entry(path: string): TreeEntry | undefined {
    const value = this.values.get(path);
    if (!value) return undefined;
    return {
      path,
      kind: value.kind,
      size: value.content?.length ?? 0,
      mtimeMs: value.revision,
      ctimeMs: value.revision,
    };
  }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function setup(local: MemoryTree, remote: MemoryTree) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-engine-"));
  roots.push(root);
  const state = new StateStore(path.join(root, ".antler"));
  await state.initialize("project");
  const checkpoints: string[] = [];
  const git = {
    checkpoint: async (label: string) => {
      checkpoints.push(label);
      return `refs/test/${label}`;
    },
  } as unknown as GitCheckpoints;
  const engine = new SyncEngine({
    local,
    remote,
    state,
    objects: new ObjectStore(path.join(root, ".antler")),
    git,
    concurrency: 4,
    maxDeletes: 20,
    maxDeletePercent: 100,
  });
  return { engine, state, checkpoints };
}

describe("bidirectional sync engine", () => {
  it("copies one-sided initial files and baselines identical files", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("local.txt", "local");
    remote.seedFile("remote.txt", "remote");
    local.seedFile("same.txt", "same");
    remote.seedFile("same.txt", "same");
    const { engine, state } = await setup(local, remote);
    const result = await engine.reconcile();
    expect(remote.text("local.txt")).toBe("local");
    expect(local.text("remote.txt")).toBe("remote");
    expect(result.conflicts).toBe(0);
    expect(Object.keys(state.current().entries).sort()).toEqual(["local.txt", "remote.txt", "same.txt"]);
  });

  it("never overwrites an initial mismatch", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("file.txt", "local");
    remote.seedFile("file.txt", "remote");
    const { engine, state } = await setup(local, remote);
    const result = await engine.reconcile();
    expect(result.conflicts).toBe(1);
    expect(local.text("file.txt")).toBe("local");
    expect(remote.text("file.txt")).toBe("remote");
    await engine.resolve("file.txt", "local");
    expect(remote.text("file.txt")).toBe("local");
    expect(Object.keys((await new StateStore(state.directory).load()).conflicts)).toHaveLength(0);
  });

  it("propagates one-sided edits and checkpoints inbound overwrites", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("file.txt", "base");
    remote.seedFile("file.txt", "base");
    const { engine, checkpoints } = await setup(local, remote);
    await engine.reconcile();
    local.seedFile("file.txt", "local edit");
    await engine.reconcile({ paths: ["file.txt"] });
    expect(remote.text("file.txt")).toBe("local edit");
    remote.seedFile("file.txt", "remote edit");
    await engine.reconcile({ paths: ["file.txt"] });
    expect(local.text("file.txt")).toBe("remote edit");
    expect(checkpoints).toHaveLength(1);
  });

  it("preserves simultaneous edits as a conflict", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("file.txt", "base");
    remote.seedFile("file.txt", "base");
    const { engine } = await setup(local, remote);
    await engine.reconcile();
    local.seedFile("file.txt", "local edit");
    remote.seedFile("file.txt", "remote edit");
    const result = await engine.reconcile({ paths: ["file.txt"] });
    expect(result.conflicts).toBe(1);
    expect(local.text("file.txt")).toBe("local edit");
    expect(remote.text("file.txt")).toBe("remote edit");
  });

  it("requires delete approval and then deletes only the unchanged survivor", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("file.txt", "base");
    remote.seedFile("file.txt", "base");
    const { engine } = await setup(local, remote);
    await engine.reconcile();
    local.remove("file.txt");
    let result = await engine.reconcile();
    expect(result.pendingDeletes).toBe(1);
    expect(remote.text("file.txt")).toBe("base");
    result = await engine.reconcile({ approveDeletes: true });
    expect(result.pendingDeletes).toBe(0);
    expect(remote.text("file.txt")).toBeUndefined();
  });

  it("leaves a journal record when a destination write fails and recovers on full reconcile", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("file.txt", "base");
    remote.seedFile("file.txt", "base");
    const { engine, state } = await setup(local, remote);
    await engine.reconcile();
    local.seedFile("file.txt", "value");
    remote.failNextWrite = true;
    await expect(engine.reconcile()).rejects.toThrow(/injected/);
    expect(Object.keys(state.current().journal)).toHaveLength(1);
    await engine.reconcile();
    expect(remote.text("file.txt")).toBe("value");
    expect(Object.keys(state.current().journal)).toHaveLength(0);
  });

  it("creates missing destination parents during a targeted new-file event", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedDirectory("nested");
    local.seedFile("nested/file.txt", "value");
    const { engine } = await setup(local, remote);
    await engine.reconcile({ paths: ["nested/file.txt"] });
    expect((await remote.stat("nested"))?.kind).toBe("directory");
    expect(remote.text("nested/file.txt")).toBe("value");
  });

  it("reconciles an upload that succeeded before its acknowledgement was lost", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("file.txt", "base");
    remote.seedFile("file.txt", "base");
    const { engine, state } = await setup(local, remote);
    await engine.reconcile();
    local.seedFile("file.txt", "new value");
    remote.failAfterWrite = true;
    await expect(engine.reconcile({ paths: ["file.txt"] })).rejects.toThrow(/lost acknowledgement/);
    expect(remote.text("file.txt")).toBe("new value");
    expect(Object.keys(state.current().journal)).toHaveLength(1);
    const recovered = await engine.reconcile();
    expect(recovered.conflicts).toBe(0);
    expect(Object.keys(state.current().journal)).toHaveLength(0);
  });

  it("coalesces concurrent inbound changes into one Git checkpoint", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    for (const file of ["a.txt", "b.txt"]) {
      local.seedFile(file, "base");
      remote.seedFile(file, "base");
    }
    const { engine, checkpoints } = await setup(local, remote);
    await engine.reconcile();
    remote.seedFile("a.txt", "remote a");
    remote.seedFile("b.txt", "remote b");
    await engine.reconcile({ paths: ["a.txt", "b.txt"] });
    expect(checkpoints).toHaveLength(1);
    expect(local.text("a.txt")).toBe("remote a");
    expect(local.text("b.txt")).toBe("remote b");
  });

  it("propagates an unambiguous local rename without a pending deletion", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("old.txt", "same bytes");
    remote.seedFile("old.txt", "same bytes");
    const { engine } = await setup(local, remote);
    await engine.reconcile();
    await local.rename("old.txt", "new.txt");
    const result = await engine.reconcile({ paths: ["old.txt", "new.txt"] });
    expect(result.pendingDeletes).toBe(0);
    expect(remote.text("old.txt")).toBeUndefined();
    expect(remote.text("new.txt")).toBe("same bytes");
    expect(result.events.some((event) => event.type === "rename-remote")).toBe(true);
  });

  it("propagates an unambiguous remote rename with one local checkpoint", async () => {
    const local = new MemoryTree("local");
    const remote = new MemoryTree("remote");
    local.seedFile("old.txt", "same bytes");
    remote.seedFile("old.txt", "same bytes");
    const { engine, checkpoints } = await setup(local, remote);
    await engine.reconcile();
    await remote.rename("old.txt", "new.txt");
    const result = await engine.reconcile({ paths: ["old.txt", "new.txt"] });
    expect(result.pendingDeletes).toBe(0);
    expect(local.text("old.txt")).toBeUndefined();
    expect(local.text("new.txt")).toBe("same bytes");
    expect(checkpoints).toHaveLength(1);
  });
});
