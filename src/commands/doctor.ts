import { Logger } from "../logging.js";
import { openProjectRuntime } from "./runtime.js";

export async function doctorProject(localRoot: string, passwordFile: string | undefined, logger: Logger): Promise<void> {
  const runtime = await openProjectRuntime(localRoot, logger, { ...(passwordFile ? { passwordFile } : {}) });
  try {
    const { client } = await runtime.manager.get();
    const watch = await client.watch(
      runtime.config.remote.root,
      () => undefined,
      (error) => logger.warn("Remote watcher reported an error", { error }),
      ["**/.git/**", "**/.moose_proxy/**"],
    );
    await watch.dispose();
    logger.success("Remote file-change subscription is available");
    const [localEntries, remoteEntries] = await Promise.all([runtime.local.scan(), runtime.remote.scan()]);
    logger.success("Both trees are readable", { localEntries: localEntries.size, remoteEntries: remoteEntries.size });
    logger.success("Doctor found no blocking problems");
  } finally {
    await runtime.close();
  }
}
