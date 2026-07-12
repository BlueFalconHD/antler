import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { RemoteAgentManager } from "../remoteAgentManager.js";
import type { RemoteWatch } from "../vscode/remoteFileSystem.js";
import {
  isHardExcluded,
  isLocalPathInside,
  isTemporaryName,
  normalizeLocalRelativePath,
  relativeRemotePath,
} from "./paths.js";

export interface ChangeWatcher {
  close(): Promise<void>;
}

export type LocalWatchErrorSource = "event" | "watcher";

export function localWatchPath(
  root: string,
  rawName: string | Buffer,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const rawPath = Buffer.isBuffer(rawName) ? rawName.toString("utf8") : rawName;
  // Filter reserved components before normalizing. macOS recursive watchers
  // can report either root-relative or absolute names depending on the event.
  if (isHardExcluded(rawPath)) return undefined;
  const implementation = platform === "win32" ? path.win32 : path.posix;
  let relative = rawPath;
  if (implementation.isAbsolute(rawPath)) {
    const resolvedRoot = implementation.resolve(root);
    const resolvedPath = implementation.resolve(rawPath);
    if (!isLocalPathInside(resolvedRoot, resolvedPath, platform)) {
      throw new Error("Local watcher path escapes the configured root");
    }
    relative = implementation.relative(resolvedRoot, resolvedPath);
  }
  if (isTemporaryName(implementation.basename(relative))) return undefined;
  const normalized = normalizeLocalRelativePath(relative.split(implementation.sep).join("/"), platform);
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
    ["**/.git/**", "**/.antler/**", "**/.antler-tmp-*", "**/.moose_proxy/**", "**/.moose_proxy-tmp-*"],
  );
  return { close: () => remoteWatch.dispose() };
}
