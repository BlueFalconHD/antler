import { Logger } from "../logging.js";
import {
  loadProjectConfig,
  saveProjectConfig,
  type DeletePolicy,
} from "../projectConfig.js";

export async function setDeletePolicy(
  projectRoot: string,
  deletePolicy: DeletePolicy,
  logger: Logger,
): Promise<void> {
  const config = await loadProjectConfig(projectRoot);
  if (config.sync.deletePolicy === deletePolicy) {
    logger.info(`Delete policy is already ${deletePolicy}`);
    return;
  }
  await saveProjectConfig(projectRoot, {
    ...config,
    sync: { ...config.sync, deletePolicy },
  });
  logger.success(`Delete policy set to ${deletePolicy}`, {
    ...(deletePolicy === "allow" ? { behavior: "one-sided deletions propagate automatically" } : {}),
    restartLiveSync: true,
  });
}
