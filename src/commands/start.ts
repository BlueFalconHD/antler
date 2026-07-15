import { Logger } from "../logging.js";
import { startLiveSyncControl, type LiveSyncControl } from "../liveSyncControl.js";
import { SyncDaemon } from "../sync/syncDaemon.js";
import { openProjectRuntime } from "./runtime.js";

export async function startProject(projectRoot: string, passwordFile: string | undefined, logger: Logger): Promise<void> {
  const runtime = await openProjectRuntime(projectRoot, logger, { ...(passwordFile ? { passwordFile } : {}) });
  const daemon = new SyncDaemon({
    localRoot: runtime.paths.syncRoot,
    remoteRoot: runtime.config.remote.root,
    manager: runtime.manager,
    engine: runtime.engine,
    logger,
    debounceMilliseconds: runtime.config.sync.debounceMilliseconds,
    reconciliationIntervalSeconds: runtime.config.sync.reconciliationIntervalSeconds,
    deletePolicy: runtime.config.sync.deletePolicy,
  });
  let control: LiveSyncControl | undefined;
  try {
    await daemon.start();
    control = await startLiveSyncControl(runtime.paths.stateDirectory, (request) =>
      daemon.requestReconciliation({
        approveDeletes: request.approveDeletes,
        forceLargeDelete: request.forceLargeDelete,
      }));
    logger.success("Live synchronization is running", {
      local: runtime.paths.syncRoot,
      remote: runtime.config.remote.root,
      deletePolicy: runtime.config.sync.deletePolicy,
    });
    await waitForShutdown();
  } finally {
    logger.info("Stopping synchronization safely");
    await control?.close();
    await daemon.stop();
    await runtime.close();
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
