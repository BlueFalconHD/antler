import { promises as fs } from "node:fs";
import path from "node:path";
import { authenticateCodeServer } from "../auth/codeServerAuth.js";
import { LEGITIMOOSE_COMPATIBILITY } from "../compatibility/legitimoose.js";
import { Logger } from "../logging.js";
import {
  createProjectConfig,
  parseConnectionUrl,
  saveProjectConfig,
} from "../projectConfig.js";
import { assertSafeProjectPaths, configuredSyncRoot, resolveProjectPaths } from "../projectPaths.js";
import { loadCodeServerPassword, promptText } from "../secrets.js";
import { LEGACY_STATE_DIRECTORY_NAME, STATE_DIRECTORY_NAME } from "../sync/paths.js";
import { StateStore } from "../sync/stateStore.js";
import { openConfiguredRuntime } from "./runtime.js";

export interface InitOptions {
  readonly url?: string;
  readonly remoteRoot?: string;
  readonly passwordFile?: string;
  readonly insecureSkipTlsVerify?: boolean;
  readonly omitOrigin?: boolean;
  readonly allowVersionMismatch?: boolean;
  readonly git?: boolean;
  readonly syncRoot?: string;
}

export async function initializeProject(directory: string, options: InitOptions, logger: Logger): Promise<void> {
  const projectRoot = path.resolve(directory);
  await fs.mkdir(projectRoot, { recursive: true });
  const rootStat = await fs.lstat(projectRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Local project must be a non-symlink directory");
  }
  for (const stateName of [STATE_DIRECTORY_NAME, LEGACY_STATE_DIRECTORY_NAME]) {
    try {
      await fs.lstat(path.join(projectRoot, stateName));
      throw new Error(`${projectRoot} already contains Antler state; run antler status`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const rawUrl = options.url ?? process.env.ANTLER_CODE_SERVER_URL ?? await promptText("Paste the full browser workspace URL");
  const parsed = parseConnectionUrl(rawUrl);
  const remoteRoot = options.remoteRoot ?? parsed.remoteRoot ?? process.env.ANTLER_REMOTE_ROOT ?? await promptText("Remote project root");
  const password = await loadCodeServerPassword(options.passwordFile);
  const rejectUnauthorized = !options.insecureSkipTlsVerify;
  if (!rejectUnauthorized) logger.warn("TLS certificate verification is disabled for this project");

  logger.info("Checking Legitimoose authentication and protocol identity", { origin: parsed.baseUrl.origin });
  const probeSession = await authenticateCodeServer({ baseUrl: parsed.baseUrl, password, rejectUnauthorized });
  let remoteCommit: string;
  try {
    remoteCommit = await probeSession.probeVersion();
  } finally {
    await probeSession.close();
  }
  if (remoteCommit !== LEGITIMOOSE_COMPATIBILITY.productCommit && !options.allowVersionMismatch) {
    throw new Error(
      `Legitimoose ${LEGITIMOOSE_COMPATIBILITY.serverVersion} expects ` +
      `${LEGITIMOOSE_COMPATIBILITY.productCommit}, but the server reports ${remoteCommit || "(empty)"}`,
    );
  }
  logger.success(`Detected Legitimoose ${LEGITIMOOSE_COMPATIBILITY.serverVersion}`, { commit: remoteCommit });

  const config = createProjectConfig({
    url: parsed.baseUrl,
    remoteRoot,
    ...(options.passwordFile ? { passwordFile: options.passwordFile } : {}),
    rejectUnauthorized,
    sendOrigin: !options.omitOrigin,
    allowVersionMismatch: options.allowVersionMismatch ?? false,
    gitEnabled: options.git ?? true,
    syncRoot: configuredSyncRoot(projectRoot, options.syncRoot),
  });
  const paths = resolveProjectPaths(projectRoot, config);
  await fs.mkdir(paths.syncRoot, { recursive: true });
  await assertSafeProjectPaths(paths);
  const state = new StateStore(paths.stateDirectory);
  await state.initialize(config.projectId);
  await saveProjectConfig(projectRoot, config);
  logger.success("Created safe project state", { stateDirectory: paths.stateDirectory, syncRoot: paths.syncRoot });

  const runtime = await openConfiguredRuntime(projectRoot, config, state, password, logger);
  try {
    const result = await runtime.engine.reconcile();
    logger.success("Initial synchronization complete", {
      transferredBytes: result.transferredBytes,
      conflicts: result.conflicts,
      pendingDeletes: result.pendingDeletes,
    });
    if (result.conflicts > 0) {
      logger.warn("Differing files were preserved on both sides", {
        next: "antler conflicts",
      });
    }
    logger.info("Start live synchronization with: antler start", { projectRoot, syncRoot: paths.syncRoot });
  } finally {
    await runtime.close();
  }
}
