import { promises as fs } from "node:fs";
import path from "node:path";
import { authenticateCodeServer } from "../auth/codeServerAuth.js";
import {
  compatibilityProfiles,
  type CompatibilityProfileName,
} from "../compatibility/profiles.js";
import { Logger } from "../logging.js";
import {
  configPath,
  createProjectConfig,
  parseConnectionUrl,
  profileForCommit,
  saveProjectConfig,
} from "../projectConfig.js";
import { loadCodeServerPassword, promptText } from "../secrets.js";
import { STATE_DIRECTORY_NAME } from "../sync/paths.js";
import { StateStore } from "../sync/stateStore.js";
import { openConfiguredRuntime } from "./runtime.js";

export interface InitOptions {
  readonly url?: string;
  readonly remoteRoot?: string;
  readonly profile?: CompatibilityProfileName;
  readonly passwordFile?: string;
  readonly insecureSkipTlsVerify?: boolean;
  readonly omitOrigin?: boolean;
  readonly allowVersionMismatch?: boolean;
  readonly git?: boolean;
}

export async function initializeProject(directory: string, options: InitOptions, logger: Logger): Promise<void> {
  const localRoot = path.resolve(directory);
  await fs.mkdir(localRoot, { recursive: true });
  const rootStat = await fs.lstat(localRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Local project must be a non-symlink directory");
  }
  try {
    await fs.lstat(configPath(localRoot));
    throw new Error(`${localRoot} is already initialized; run moose-proxy status`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const rawUrl = options.url ?? await promptText("Paste the code-server URL");
  const parsed = parseConnectionUrl(rawUrl);
  const remoteRoot = options.remoteRoot ?? parsed.remoteRoot ?? await promptText("Remote project root");
  const password = await loadCodeServerPassword(options.passwordFile);
  const rejectUnauthorized = !options.insecureSkipTlsVerify;
  if (!rejectUnauthorized) logger.warn("TLS certificate verification is disabled for this project");

  logger.info("Checking authentication and compatibility", { origin: parsed.baseUrl.origin });
  const probeSession = await authenticateCodeServer({ baseUrl: parsed.baseUrl, password, rejectUnauthorized });
  let remoteCommit: string;
  try {
    remoteCommit = await probeSession.probeVersion();
  } finally {
    await probeSession.close();
  }
  const detectedProfile = profileForCommit(remoteCommit);
  const profileName = options.profile ?? detectedProfile;
  if (!profileName) {
    throw new Error(
      `The remote commit ${remoteCommit || "(empty)"} is not in the compatibility matrix. ` +
      "Choose --profile only after verifying its protocol behavior.",
    );
  }
  const profile = compatibilityProfiles[profileName];
  if (remoteCommit !== profile.productCommit && !options.allowVersionMismatch) {
    throw new Error(`Selected profile ${profileName} expects ${profile.productCommit}, but the server reports ${remoteCommit}`);
  }
  logger.success(`Detected ${profileName}`, { commit: remoteCommit });

  const config = createProjectConfig({
    url: parsed.baseUrl,
    remoteRoot,
    profile: profileName,
    ...(options.passwordFile ? { passwordFile: options.passwordFile } : {}),
    rejectUnauthorized,
    sendOrigin: !options.omitOrigin,
    allowVersionMismatch: options.allowVersionMismatch ?? false,
    gitEnabled: options.git ?? true,
  });
  const stateDirectory = path.join(localRoot, STATE_DIRECTORY_NAME);
  const state = new StateStore(stateDirectory);
  await state.initialize(config.projectId);
  await saveProjectConfig(localRoot, config);
  logger.success("Created safe project state", { stateDirectory });

  const runtime = await openConfiguredRuntime(localRoot, config, state, password, logger);
  try {
    const result = await runtime.engine.reconcile();
    logger.success("Initial synchronization complete", {
      transferredBytes: result.transferredBytes,
      conflicts: result.conflicts,
      pendingDeletes: result.pendingDeletes,
    });
    if (result.conflicts > 0) {
      logger.warn("Differing files were preserved on both sides", {
        next: "moose-proxy conflicts",
      });
    }
    logger.info("Start live synchronization with: moose-proxy start", { localRoot });
  } finally {
    await runtime.close();
  }
}
