import path from "node:path";

export const STATE_DIRECTORY_NAME = ".antler";
export const LEGACY_STATE_DIRECTORY_NAME = ".moose_proxy";
export const TEMPORARY_FILE_PREFIX = ".antler-tmp-";
export const LEGACY_TEMPORARY_FILE_PREFIX = ".moose_proxy-tmp-";
export const HARD_EXCLUDED_NAMES = new Set([STATE_DIRECTORY_NAME, LEGACY_STATE_DIRECTORY_NAME, ".git"]);

export function validateRemoteRoot(remoteRoot: string): string {
  if (!remoteRoot.startsWith("/") || remoteRoot.includes("\0") || remoteRoot.includes("\\")) {
    throw new Error("Remote root must be an absolute POSIX path without NUL or backslash");
  }
  if (remoteRoot.split("/").includes("..")) {
    throw new Error("Remote root must not contain parent traversal");
  }
  const normalized = path.posix.normalize(remoteRoot);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length > 32_768 || input.includes("\0") || input.includes("\\")) {
    throw new Error("Malformed sync path");
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw new Error("Sync paths must be relative");
  }
  const pieces = input.split("/").filter((piece) => piece !== "" && piece !== ".");
  if (pieces.includes("..")) {
    throw new Error("Parent traversal is not allowed");
  }
  for (const piece of pieces) {
    if (HARD_EXCLUDED_NAMES.has(piece.toLowerCase()) || isTemporaryName(piece)) {
      throw new Error(`Reserved sync path component: ${piece}`);
    }
  }
  return pieces.join("/");
}

export function isHardExcluded(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .filter(Boolean)
    .some((piece) => HARD_EXCLUDED_NAMES.has(piece.toLowerCase()) || isTemporaryName(piece));
}

export function isTemporaryName(name: string): boolean {
  return name.startsWith(TEMPORARY_FILE_PREFIX) || name.startsWith(LEGACY_TEMPORARY_FILE_PREFIX);
}

export function localPath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const candidate = path.resolve(root, ...normalized.split("/").filter(Boolean));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new Error("Local path escapes the configured root");
  }
  return candidate;
}

export function remotePath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const candidate = normalized ? path.posix.join(root, normalized) : root;
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error("Remote path escapes the configured root");
  }
  return candidate;
}

export function relativeRemotePath(root: string, absolutePath: string): string {
  if (!absolutePath.startsWith("/") || absolutePath.includes("\\") || absolutePath.includes("\0")) {
    throw new Error("Malformed remote watcher path");
  }
  if (absolutePath === root) {
    return "";
  }
  if (!absolutePath.startsWith(`${root}/`)) {
    throw new Error("Remote watcher path escapes the configured root");
  }
  return normalizeRelativePath(absolutePath.slice(root.length + 1));
}

export function pathDepth(relativePath: string): number {
  return relativePath === "" ? 0 : relativePath.split("/").length;
}
