import path from "node:path";
import { GitCheckpoints } from "../git/checkpoints.js";
import { loadProjectConfig } from "../projectConfig.js";
import { STATE_DIRECTORY_NAME } from "../sync/paths.js";
import { StateStore } from "../sync/stateStore.js";

export async function projectStatus(localRoot: string, json: boolean): Promise<void> {
  const config = await loadProjectConfig(localRoot);
  const stateDirectory = path.join(localRoot, STATE_DIRECTORY_NAME);
  const store = new StateStore(stateDirectory);
  const state = await store.load();
  if (state.projectId !== config.projectId) {
    throw new Error("Project configuration and state identities do not match");
  }
  const git = new GitCheckpoints(localRoot, stateDirectory, config.git.enabled && config.git.checkpoints);
  const gitStatus = await git.initialize();
  const summary = {
    localRoot,
    remoteUrl: config.remote.url,
    remoteRoot: config.remote.root,
    profile: config.remote.profile,
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
      `Local       ${localRoot}`,
      `Remote      ${config.remote.root}`,
      `Profile     ${config.remote.profile}`,
      `Tracked     ${summary.trackedEntries} entries`,
      `Conflicts   ${summary.conflicts.length}`,
      `Deletions   ${summary.pendingDeletes.length} awaiting approval`,
      `Last sync   ${summary.lastReconciledAt ?? "never"}`,
      `Git         ${gitStatus.available ? `${gitStatus.branch}${gitStatus.dirty ? " (dirty)" : " (clean)"}` : gitStatus.reason}`,
      ...(summary.interruptedOperations.length > 0
        ? ["", `Recovery     ${summary.interruptedOperations.length} interrupted operation(s); next sync will fully reconcile`]
        : []),
      ...(summary.conflicts.length > 0 ? ["", "Run `moose-proxy conflicts` to inspect unresolved paths."] : []),
      ...(summary.pendingDeletes.length > 0
        ? ["Run `moose-proxy sync --approve-deletes` after reviewing them."]
        : []),
    ].join("\n") + "\n",
  );
}

export async function listConflicts(localRoot: string, json: boolean): Promise<void> {
  const store = new StateStore(path.join(localRoot, STATE_DIRECTORY_NAME));
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
    process.stdout.write("\nResolve with `moose-proxy resolve <path> --take local|remote`.\n");
  }
}
