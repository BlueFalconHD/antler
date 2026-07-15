import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncProjectOnce } from "../src/commands/sync.js";
import { requestLiveSync, startLiveSyncControl } from "../src/liveSyncControl.js";
import { Logger } from "../src/logging.js";
import { createProjectConfig, saveProjectConfig } from "../src/projectConfig.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("live synchronization control channel", () => {
  it("runs a second-terminal sync through the live process", async () => {
    const root = await temporaryProject();
    const stateDirectory = path.join(root, ".antler");
    const reconcile = vi.fn().mockResolvedValue({
      events: [],
      conflicts: 1,
      pendingDeletes: 0,
      transferredBytes: 42,
    });
    const control = await startLiveSyncControl(stateDirectory, reconcile);
    try {
      await syncProjectOnce(root, { approveDeletes: true }, quietLogger());

      expect(reconcile).toHaveBeenCalledWith({
        type: "reconcile",
        approveDeletes: true,
        forceLargeDelete: false,
      });
    } finally {
      await control.close();
    }

    await expect(requestLiveSync(stateDirectory, {
      approveDeletes: true,
      forceLargeDelete: false,
    })).resolves.toBeUndefined();
  });

  it("returns reconciliation failures to the requesting terminal", async () => {
    const root = await temporaryProject();
    const stateDirectory = path.join(root, ".antler");
    const control = await startLiveSyncControl(stateDirectory, async () => {
      throw new Error("delete circuit breaker paused this batch");
    });
    try {
      await expect(requestLiveSync(stateDirectory, {
        approveDeletes: true,
        forceLargeDelete: false,
      })).rejects.toThrow(/circuit breaker/);
    } finally {
      await control.close();
    }
  });
});

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "antler-live-control-"));
  roots.push(root);
  const config = createProjectConfig({
    url: new URL("https://code.example.test/instance/"),
    remoteRoot: "/home/coder/project/datapack",
  });
  await saveProjectConfig(root, config);
  return root;
}

function quietLogger(): Logger {
  return new Logger("error", { format: "plain", color: false });
}
