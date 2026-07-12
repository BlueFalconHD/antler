import { Logger } from "../logging.js";
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
  const runtime = await openProjectRuntime(localRoot, logger, {
    ...(options.passwordFile ? { passwordFile: options.passwordFile } : {}),
  });
  try {
    const result = await runtime.engine.reconcile({
      approveDeletes: options.approveDeletes ?? false,
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
