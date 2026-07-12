import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { RemoteAgentManager } from "../remoteAgentManager.js";
import type { RemoteWatch } from "../vscode/remoteFileSystem.js";
import { isHardExcluded, normalizeRelativePath, relativeRemotePath } from "./paths.js";

export interface ChangeWatcher {
  close(): Promise<void>;
}

export function watchLocal(
  root: string,
  onPaths: (paths: readonly string[]) => void,
  onError: (error: Error) => void,
): ChangeWatcher {
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: true }, (_event, rawName) => {
      if (rawName === null) {
        onPaths([]);
        return;
      }
      try {
        const relative = normalizeRelativePath(Buffer.isBuffer(rawName) ? rawName.toString("utf8") : rawName);
        if (!relative || isHardExcluded(relative) || path.basename(relative).startsWith(".moose_proxy-tmp-")) {
          return;
        }
        onPaths([relative]);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } catch (error) {
    throw new Error(`Unable to start local filesystem watcher: ${error instanceof Error ? error.message : String(error)}`);
  }
  watcher.on("error", onError);
  return {
    close: async () => {
      watcher.close();
    },
  };
}

export async function watchRemote(
  manager: RemoteAgentManager,
  root: string,
  onPaths: (paths: readonly string[]) => void,
  onError: (error: Error) => void,
): Promise<ChangeWatcher> {
  const { client } = await manager.get();
  const remoteWatch: RemoteWatch = await client.watch(
    root,
    (changes) => {
      try {
        const paths = changes
          .map((change) => relativeRemotePath(root, change.path))
          .filter((entry) => entry && !isHardExcluded(entry));
        if (paths.length > 0) {
          onPaths(paths);
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError,
    ["**/.git/**", "**/.moose_proxy/**", "**/.moose_proxy-tmp-*"],
  );
  return { close: () => remoteWatch.dispose() };
}
