import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { RemoteAgentManager } from "../remoteAgentManager.js";
import type { RemoteWatch } from "../vscode/remoteFileSystem.js";
import { isHardExcluded, normalizeRelativePath, relativeRemotePath } from "./paths.js";

export interface ChangeWatcher {
  close(): Promise<void>;
}

export type LocalWatchErrorSource = "event" | "watcher";

export function localWatchPath(root: string, rawName: string | Buffer): string | undefined {
  const rawPath = Buffer.isBuffer(rawName) ? rawName.toString("utf8") : rawName;
  // Filter reserved components before normalizing. macOS recursive watchers
  // can report either root-relative or absolute names depending on the event.
  if (isHardExcluded(rawPath)) return undefined;
  let relative = rawPath;
  if (path.isAbsolute(rawPath)) {
    relative = path.relative(path.resolve(root), path.resolve(rawPath));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Local watcher path escapes the configured root");
    }
  }
  if (path.basename(relative).startsWith(".moose_proxy-tmp-")) return undefined;
  const normalized = normalizeRelativePath(relative.split(path.sep).join("/"));
  return normalized || undefined;
}

export function watchLocal(
  root: string,
  onPaths: (paths: readonly string[]) => void,
  onError: (error: Error, source: LocalWatchErrorSource) => void,
): ChangeWatcher {
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: true }, (_event, rawName) => {
      if (rawName === null) {
        onPaths([]);
        return;
      }
      try {
        const relative = localWatchPath(root, rawName);
        if (!relative) return;
        onPaths([relative]);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)), "event");
      }
    });
  } catch (error) {
    throw new Error(`Unable to start local filesystem watcher: ${error instanceof Error ? error.message : String(error)}`);
  }
  watcher.on("error", (error) => onError(error, "watcher"));
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
          .map((change) => {
            if (change.path !== root && !change.path.startsWith(`${root}/`)) {
              throw new Error("Remote watcher path escapes the configured root");
            }
            const rawRelative = change.path === root ? "" : change.path.slice(root.length + 1);
            return isHardExcluded(rawRelative) ? undefined : relativeRemotePath(root, change.path);
          })
          .filter((entry): entry is string => Boolean(entry));
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
