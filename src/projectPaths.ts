import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "./projectConfig.js";
import { isLocalPathInside, STATE_DIRECTORY_NAME } from "./sync/paths.js";

export interface ProjectPaths {
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly syncRoot: string;
}

export function normalizeConfiguredSyncRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error("Local sync root must be a relative POSIX path inside the project");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Local sync root must stay inside the project");
  }
  return normalized;
}

export function configuredSyncRoot(projectRoot: string, requestedRoot: string | undefined): string {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedSyncRoot = path.resolve(resolvedProjectRoot, requestedRoot ?? ".");
  if (!isLocalPathInside(resolvedProjectRoot, resolvedSyncRoot)) {
    throw new Error("Local sync root must stay inside the project");
  }
  const relative = path.relative(resolvedProjectRoot, resolvedSyncRoot);
  return normalizeConfiguredSyncRoot(relative ? relative.split(path.sep).join("/") : ".");
}

export function resolveProjectPaths(projectRoot: string, config: ProjectConfig): ProjectPaths {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const syncRoot = path.resolve(resolvedProjectRoot, ...config.local.root.split("/"));
  if (!isLocalPathInside(resolvedProjectRoot, syncRoot)) {
    throw new Error("Configured local sync root escapes the project");
  }
  return {
    projectRoot: resolvedProjectRoot,
    stateDirectory: path.join(resolvedProjectRoot, STATE_DIRECTORY_NAME),
    syncRoot,
  };
}

export async function assertSafeProjectPaths(paths: ProjectPaths): Promise<void> {
  const [projectStat, syncStat, canonicalProjectRoot, canonicalSyncRoot] = await Promise.all([
    fs.lstat(paths.projectRoot),
    fs.lstat(paths.syncRoot),
    fs.realpath(paths.projectRoot),
    fs.realpath(paths.syncRoot),
  ]);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
    throw new Error("Local project must be a non-symlink directory");
  }
  if (!syncStat.isDirectory() || syncStat.isSymbolicLink()) {
    throw new Error("Local sync root must be a non-symlink directory");
  }
  if (!isLocalPathInside(canonicalProjectRoot, canonicalSyncRoot)) {
    throw new Error("Local sync root resolves outside the project");
  }
}
