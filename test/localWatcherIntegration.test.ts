import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTree } from "../src/sync/localTree.js";
import { watchLocal } from "../src/sync/watchers.js";

describe("local filesystem behavior", () => {
  it.runIf(process.platform === "win32")("receives recursive file events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-watch-"));
    await fs.mkdir(path.join(root, "nested"));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectEvent: (error: Error) => void = () => undefined;
    let resolveEvent: (value: string) => void = () => undefined;
    const event = new Promise<string>((resolve, reject) => {
      rejectEvent = reject;
      timeout = setTimeout(() => reject(new Error("Timed out waiting for a recursive file event")), 5_000);
      const complete = (value: string) => {
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      resolveEvent = complete;
    });
    const watcher = watchLocal(
      root,
      (paths) => {
        if (paths.includes("nested/example.json")) resolveEvent("nested/example.json");
      },
      (error) => rejectEvent(error),
    );
    try {
      const observed = expect(event).resolves.toBe("nested/example.json");
      await fs.writeFile(path.join(root, "nested", "example.json"), "{}\n");
      await observed;
    } finally {
      if (timeout) clearTimeout(timeout);
      await watcher.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("rejects a differently-cased alias of an existing path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-case-"));
    try {
      await fs.writeFile(path.join(root, "MixedCase.txt"), "contents");
      const tree = new LocalTree({ root });
      await tree.initialize();
      await expect(tree.stat("mixedcase.txt")).rejects.toThrow(/casing differs/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
