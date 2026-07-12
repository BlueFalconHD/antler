import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectLock } from "../src/projectLock.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("project operation lock", () => {
  it("prevents concurrent Antler runtimes and releases cleanly", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const first = await ProjectLock.acquire(stateDirectory, "first");

    await expect(ProjectLock.acquire(stateDirectory, "second")).rejects.toThrow(/first.*pid/s);
    await first.release();

    const second = await ProjectLock.acquire(stateDirectory, "second");
    await second.release();
  });

  it("atomically recovers a lock owned by a dead local process", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockDirectory = path.join(stateDirectory, "operation.lock");
    await fs.mkdir(lockDirectory);
    await fs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      operation: "crashed",
      startedAt: "2020-01-01T00:00:00.000Z",
    }));

    const lock = await ProjectLock.acquire(stateDirectory, "replacement");
    await lock.release();

    await expect(fs.lstat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryStateDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-lock-"));
  roots.push(root);
  const stateDirectory = path.join(root, ".antler");
  await fs.mkdir(stateDirectory);
  return stateDirectory;
}
