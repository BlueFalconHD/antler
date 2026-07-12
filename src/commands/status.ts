import { GitCheckpoints } from "../git/checkpoints.js";
import { loadProjectConfig } from "../projectConfig.js";
import { ProjectLock } from "../projectLock.js";
import { resolveProjectPaths } from "../projectPaths.js";
import { StateStore } from "../sync/stateStore.js";

export async function projectStatus(projectRoot: string, json: boolean): Promise<void> {
  const config = await loadProjectConfig(projectRoot);
  const paths = resolveProjectPaths(projectRoot, config);
  const store = new StateStore(paths.stateDirectory);
  const state = await store.load();
  if (state.projectId !== config.projectId) {
    throw new Error("Project configuration and state identities do not match");
  }
  const git = new GitCheckpoints(paths.projectRoot, paths.syncRoot, paths.stateDirectory, config.git.enabled && config.git.checkpoints);
  const gitStatus = await git.initialize();
  const summary = {
    projectRoot: paths.projectRoot,
    localRoot: paths.syncRoot,
    remoteUrl: config.remote.url,
    remoteRoot: config.remote.root,
    trackedEntries: Object.keys(state.entries).length,
    conflicts: Object.values(state.conflicts),
    pendingDeletes: Object.values(state.pendingDeletes),
    interruptedOperations: Object.values(state.journal),
    lastReconciledAt: state.lastReconciledAt ?? null,
    git: gitStatus,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      ...(paths.projectRoot === paths.syncRoot ? [] : [`Project     ${paths.projectRoot}`]),
      `Local       ${paths.syncRoot}`,
      `Remote      ${config.remote.root}`,
      `Tracked     ${summary.trackedEntries} entries`,
      `Conflicts   ${summary.conflicts.length}`,
      `Deletions   ${summary.pendingDeletes.length} awaiting approval`,
      `Last sync   ${summary.lastReconciledAt ?? "never"}`,
      `Git         ${gitStatus.available ? `${gitStatus.branch}${gitStatus.dirty ? " (dirty)" : " (clean)"}` : gitStatus.reason}`,
      ...(summary.interruptedOperations.length > 0
        ? ["", `Recovery     ${summary.interruptedOperations.length} interrupted operation(s); next sync will fully reconcile`]
        : []),
      ...(summary.conflicts.length > 0 ? ["", "Run `antler conflicts` to inspect unresolved paths."] : []),
      ...(summary.pendingDeletes.length > 0
        ? ["Run `antler sync --approve-deletes` after reviewing them."]
        : []),
    ].join("\n") + "\n",
  );
}

export async function listConflicts(projectRoot: string, json: boolean): Promise<void> {
  const config = await loadProjectConfig(projectRoot);
  const store = new StateStore(resolveProjectPaths(projectRoot, config).stateDirectory);
  const state = await store.load();
  const conflicts = Object.values(state.conflicts).sort((left, right) => left.path.localeCompare(right.path));
  if (json) {
    process.stdout.write(`${JSON.stringify(conflicts, null, 2)}\n`);
  } else if (conflicts.length === 0) {
    process.stdout.write("No unresolved conflicts.\n");
  } else {
    for (const conflict of conflicts) {
      process.stdout.write(`⚠ ${conflict.path}  ${conflict.reason}\n`);
    }
    process.stdout.write("\nResolve with `antler resolve <path> --take local|remote`.\n");
  }
}

export async function listCheckpoints(projectRoot: string, json: boolean): Promise<void> {
  const config = await loadProjectConfig(projectRoot);
  const paths = resolveProjectPaths(projectRoot, config);
  const git = new GitCheckpoints(paths.projectRoot, paths.syncRoot, paths.stateDirectory, config.git.enabled && config.git.checkpoints);
  const status = await git.initialize();
  if (!status.available) throw new Error(status.reason ?? "Git checkpoints are unavailable");
  const checkpoints = await git.list();
  if (json) {
    process.stdout.write(`${JSON.stringify(checkpoints, null, 2)}\n`);
  } else if (checkpoints.length === 0) {
    process.stdout.write("No safety checkpoints have been created yet.\n");
  } else {
    for (const checkpoint of checkpoints) {
      process.stdout.write(`${checkpoint.createdAt}  ${checkpoint.reference}\n`);
    }
  }
}

export async function restoreCheckpoint(
  projectRoot: string,
  reference: string,
  relativePath: string,
): Promise<string> {
  const config = await loadProjectConfig(projectRoot);
  const paths = resolveProjectPaths(projectRoot, config);
  const lock = await ProjectLock.acquire(paths.stateDirectory, "restore");
  try {
    const git = new GitCheckpoints(paths.projectRoot, paths.syncRoot, paths.stateDirectory, config.git.enabled && config.git.checkpoints);
    const status = await git.initialize();
    if (!status.available) throw new Error(status.reason ?? "Git checkpoints are unavailable");
    return await git.restore(reference, relativePath);
  } finally {
    await lock.release();
  }
}
