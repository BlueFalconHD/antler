import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "../src/logging.js";
import type { RemoteAgentManager } from "../src/remoteAgentManager.js";
import { SyncDaemon } from "../src/sync/syncDaemon.js";
import type { SyncEngine } from "../src/sync/syncEngine.js";

vi.mock("../src/sync/watchers.js", () => ({
  watchLocal: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  watchRemote: vi.fn(async () => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));

const result = { events: [], conflicts: 0, pendingDeletes: 0, transferredBytes: 0 };

describe("live synchronization daemon requests", () => {
  it("serializes an externally requested delete approval through the daemon", async () => {
    const reconcile = vi.fn().mockResolvedValue(result);
    const daemon = createDaemon("confirm", reconcile);
    await daemon.start();
    try {
      await expect(daemon.requestReconciliation({
        approveDeletes: true,
        forceLargeDelete: true,
      })).resolves.toEqual(result);

      expect(reconcile).toHaveBeenNthCalledWith(1, {});
      expect(reconcile).toHaveBeenNthCalledWith(2, {
        approveDeletes: true,
        forceLargeDelete: true,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("automatically approves deletions when the configured policy is allow", async () => {
    const reconcile = vi.fn().mockResolvedValue(result);
    const daemon = createDaemon("allow", reconcile);
    await daemon.start();
    try {
      await daemon.requestReconciliation({ approveDeletes: false });

      expect(reconcile).toHaveBeenNthCalledWith(1, { approveDeletes: true });
      expect(reconcile).toHaveBeenNthCalledWith(2, { approveDeletes: true });
    } finally {
      await daemon.stop();
    }
  });
});

function createDaemon(deletePolicy: "confirm" | "allow", reconcile: ReturnType<typeof vi.fn>): SyncDaemon {
  const manager = new EventEmitter() as RemoteAgentManager;
  return new SyncDaemon({
    localRoot: "/tmp/antler-local",
    remoteRoot: "/remote/antler",
    manager,
    engine: { reconcile } as unknown as SyncEngine,
    logger: new Logger("error", { format: "plain", color: false }),
    debounceMilliseconds: 1,
    reconciliationIntervalSeconds: 3_600,
    deletePolicy,
  });
}
