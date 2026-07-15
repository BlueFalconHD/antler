import { Logger } from "../logging.js";
import { requestLiveSync } from "../liveSyncControl.js";
import { loadProjectConfig } from "../projectConfig.js";
import { resolveProjectPaths } from "../projectPaths.js";
import { openProjectRuntime } from "./runtime.js";

export async function syncProjectOnce(
  localRoot: string,
  options: {
    readonly passwordFile?: string;
    readonly approveDeletes?: boolean;
    readonly forceLargeDelete?: boolean;
  },
  logger: Logger,
): Promise<void> {
  const config = await loadProjectConfig(localRoot);
  const paths = resolveProjectPaths(localRoot, config);
  const liveResult = await requestLiveSync(paths.stateDirectory, {
    approveDeletes: options.approveDeletes ?? false,
    forceLargeDelete: options.forceLargeDelete ?? false,
  });
  if (liveResult) {
    logger.success("Synchronization complete through the running live session", { ...liveResult });
    return;
  }
  const runtime = await openProjectRuntime(localRoot, logger, {
    ...(options.passwordFile ? { passwordFile: options.passwordFile } : {}),
  });
  try {
    const result = await runtime.engine.reconcile({
      approveDeletes: runtime.config.sync.deletePolicy === "allow" || (options.approveDeletes ?? false),
      forceLargeDelete: options.forceLargeDelete ?? false,
    });
    logger.success("Synchronization complete", {
      transferredBytes: result.transferredBytes,
      conflicts: result.conflicts,
      pendingDeletes: result.pendingDeletes,
    });
  } finally {
    await runtime.close();
  }
}
