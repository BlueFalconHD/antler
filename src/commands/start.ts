import { Logger } from "../logging.js";
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
  });
  try {
    await daemon.start();
    logger.success("Live synchronization is running", {
      local: runtime.paths.syncRoot,
      remote: runtime.config.remote.root,
    });
    await waitForShutdown();
  } finally {
    logger.info("Stopping synchronization safely");
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
