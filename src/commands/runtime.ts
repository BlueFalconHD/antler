import path from "node:path";
import { authenticateCodeServer, type CodeServerSession } from "../auth/codeServerAuth.js";
import { LEGITIMOOSE_COMPATIBILITY } from "../compatibility/legitimoose.js";
import { GitCheckpoints, type GitStatus } from "../git/checkpoints.js";
import { Logger } from "../logging.js";
import { loadProjectConfig, type ProjectConfig } from "../projectConfig.js";
import { RemoteAgentManager } from "../remoteAgentManager.js";
import { loadCodeServerPassword } from "../secrets.js";
import { TransferProgressReporter } from "../transferProgress.js";
import { IgnoreRules } from "../sync/ignoreRules.js";
import { LocalTree } from "../sync/localTree.js";
import { ObjectStore } from "../sync/objectStore.js";
import { RemoteTree } from "../sync/remoteTree.js";
import { STATE_DIRECTORY_NAME } from "../sync/paths.js";
import { StateStore } from "../sync/stateStore.js";
import { SyncEngine } from "../sync/syncEngine.js";
import type { SyncEvent } from "../sync/types.js";

export interface ProjectRuntime {
  readonly config: ProjectConfig;
  readonly session: CodeServerSession;
  readonly manager: RemoteAgentManager;
  readonly state: StateStore;
  readonly local: LocalTree;
  readonly remote: RemoteTree;
  readonly git: GitCheckpoints;
  readonly gitStatus: GitStatus;
  readonly engine: SyncEngine;
  close(): Promise<void>;
}

export async function openProjectRuntime(
  localRoot: string,
  logger: Logger,
  options: { readonly passwordFile?: string } = {},
): Promise<ProjectRuntime> {
  const config = await loadProjectConfig(localRoot);
  const stateDirectory = path.join(localRoot, STATE_DIRECTORY_NAME);
  const state = new StateStore(stateDirectory);
  const loadedState = await state.load();
  if (loadedState.projectId !== config.projectId) {
    throw new Error("Project configuration and sync state identities do not match. No files were changed");
  }
  const password = await loadCodeServerPassword(options.passwordFile ?? config.remote.passwordFile);
  return openConfiguredRuntime(localRoot, config, state, password, logger);
}

export async function openConfiguredRuntime(
  localRoot: string,
  config: ProjectConfig,
  state: StateStore,
  password: string,
  logger: Logger,
): Promise<ProjectRuntime> {
  const stateDirectory = path.join(localRoot, STATE_DIRECTORY_NAME);
  logger.info("Connecting to code-server", { origin: new URL(config.remote.url).origin });
  const session = await authenticateCodeServer({
    baseUrl: new URL(config.remote.url),
    password,
    rejectUnauthorized: config.remote.rejectUnauthorized,
  });
  const remoteVersion = await session.probeVersion();
  if (remoteVersion !== LEGITIMOOSE_COMPATIBILITY.productCommit && !config.remote.allowVersionMismatch) {
    await session.close();
    throw new Error(
      `Remote commit ${remoteVersion || "(empty)"} does not match Legitimoose ` +
      `${LEGITIMOOSE_COMPATIBILITY.serverVersion} (${LEGITIMOOSE_COMPATIBILITY.productCommit}).`,
    );
  }
  logger.success(`Connected to Legitimoose ${LEGITIMOOSE_COMPATIBILITY.serverVersion}`, {
    commit: remoteVersion,
  });
  const manager = new RemoteAgentManager({
    session,
    rejectUnauthorized: config.remote.rejectUnauthorized,
    sendOrigin: config.remote.sendOrigin,
  });
  try {
    const ignore = await IgnoreRules.load(localRoot, config.sync.ignores);
    const local = new LocalTree({ root: localRoot, shouldIgnore: (entry, directory) => ignore.ignores(entry, directory) });
    const remote = new RemoteTree({
      manager,
      root: config.remote.root,
      concurrency: config.sync.concurrency,
      shouldIgnore: (entry, directory) => ignore.ignores(entry, directory),
    });
    await Promise.all([local.initialize(), remote.initialize()]);
    logger.success("Remote root confined", { remoteRoot: config.remote.root });
    const git = new GitCheckpoints(localRoot, stateDirectory, config.git.enabled && config.git.checkpoints);
    const gitStatus = await git.initialize();
    if (gitStatus.available) {
      logger.success("Git safety checkpoints enabled", { branch: gitStatus.branch, dirty: gitStatus.dirty });
    } else {
      logger.warn("Git safety checkpoints unavailable", { reason: gitStatus.reason });
    }
    const objects = new ObjectStore(stateDirectory);
    const progressReporter = new TransferProgressReporter(logger);
    const engine = new SyncEngine({
      local,
      remote,
      state,
      objects,
      git,
      concurrency: config.sync.concurrency,
      maxDeletes: config.safety.maxDeletes,
      maxDeletePercent: config.safety.maxDeletePercent,
      onEvent: (event) => logSyncEvent(logger, event),
      onProgress: (progress) => progressReporter.report(progress),
    });
    return {
      config,
      session,
      manager,
      state,
      local,
      remote,
      git,
      gitStatus,
      engine,
      close: async () => {
        await manager.stop();
        await session.close();
      },
    };
  } catch (error) {
    await manager.stop();
    await session.close();
    throw error;
  }
}

function logSyncEvent(logger: Logger, event: SyncEvent): void {
  const details = {
    ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
  };
  switch (event.type) {
    case "upload": logger.success(`↑ Uploaded ${event.path}`, details); break;
    case "download": logger.success(`↓ Downloaded ${event.path}`, details); break;
    case "mkdir-local": logger.success(`↓ Created local directory ${event.path}`); break;
    case "mkdir-remote": logger.success(`↑ Created remote directory ${event.path}`); break;
    case "delete-local": logger.warn(`Deleted local ${event.path}`); break;
    case "delete-remote": logger.warn(`Deleted remote ${event.path}`); break;
    case "rename-local": logger.success(`↓ Renamed local ${event.path}`, details); break;
    case "rename-remote": logger.success(`↑ Renamed remote ${event.path}`, details); break;
    case "conflict": logger.warn(`Conflict: ${event.path} — neither copy was changed`, details); break;
    case "pending-delete": logger.warn(`Deletion awaiting approval: ${event.path}`, details); break;
    case "baseline": logger.debug(`Baselined ${event.path}`, details); break;
    case "unchanged": break;
  }
}
