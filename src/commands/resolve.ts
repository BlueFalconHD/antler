import { Logger } from "../logging.js";
import { openProjectRuntime } from "./runtime.js";

export async function resolveConflict(
  localRoot: string,
  path: string,
  take: "local" | "remote",
  passwordFile: string | undefined,
  logger: Logger,
): Promise<void> {
  const runtime = await openProjectRuntime(localRoot, logger, { ...(passwordFile ? { passwordFile } : {}) });
  try {
    await runtime.engine.resolve(path, take);
    logger.success(`Conflict resolved using ${take}`, { path });
  } finally {
    await runtime.close();
  }
}
