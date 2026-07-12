import path from "node:path";
import { FileType, type RemoteFileSystemClient, type RemoteStat } from "../vscode/remoteFileSystem.js";
import { SftpError, SFTP_STATUS, isNotFound } from "../sftp/errors.js";

const posix = path.posix;

export interface ResolvedRemotePath {
  readonly clientPath: string;
  readonly remotePath: string;
  readonly stat?: RemoteStat;
}

export class PathConfinement {
  public readonly remoteRoot: string;

  public constructor(
    remoteRoot: string,
    private readonly remote: RemoteFileSystemClient,
  ) {
    this.remoteRoot = validateRemoteRoot(remoteRoot);
  }

  public map(clientPath: string): ResolvedRemotePath {
    const components = validateClientPath(clientPath);
    const canonicalClientPath = components.length === 0 ? "/" : `/${components.join("/")}`;
    const remotePath = components.length === 0 ? this.remoteRoot : posix.join(this.remoteRoot, ...components);
    if (!isWithin(this.remoteRoot, remotePath)) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Path escapes configured root");
    }
    return { clientPath: canonicalClientPath, remotePath };
  }

  public async existing(clientPath: string): Promise<ResolvedRemotePath> {
    const mapped = this.map(clientPath);
    const stat = await this.inspect(mapped.remotePath, false);
    return { ...mapped, stat: stat! };
  }

  public async forCreate(clientPath: string): Promise<ResolvedRemotePath> {
    const mapped = this.map(clientPath);
    if (mapped.remotePath === this.remoteRoot) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Cannot replace configured root");
    }
    const stat = await this.inspect(mapped.remotePath, true);
    return stat === undefined ? mapped : { ...mapped, stat };
  }

  public async childOfVerifiedDirectory(
    parent: ResolvedRemotePath,
    childName: string,
  ): Promise<ResolvedRemotePath> {
    if (!parent.stat || (parent.stat.type & FileType.Directory) === 0) {
      throw new SftpError(SFTP_STATUS.FAILURE, "Verified parent is not a directory");
    }
    const components = validateClientPath(childName);
    if (components.length !== 1 || components[0] !== childName) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Invalid directory entry name");
    }
    const clientPath = parent.clientPath === "/" ? `/${childName}` : `${parent.clientPath}/${childName}`;
    const mapped = this.map(clientPath);
    if (posix.dirname(mapped.remotePath) !== parent.remotePath) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Directory entry escapes verified parent");
    }
    const stat = await this.remote.stat(mapped.remotePath);
    if ((stat.type & FileType.SymbolicLink) !== 0) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Symbolic links are denied by confinement policy");
    }
    return { ...mapped, stat };
  }

  public async verifyRoot(): Promise<void> {
    const stat = await this.inspect(this.remoteRoot, false, pathPrefixes(this.remoteRoot));
    if (!stat || (stat.type & FileType.Directory) === 0) {
      throw new Error("configured remote root is not a directory");
    }
  }

  private async inspect(
    remotePath: string,
    allowMissingFinal: boolean,
    prefixes = confinedPathPrefixes(this.remoteRoot, remotePath),
  ): Promise<RemoteStat | undefined> {
    let finalStat: RemoteStat | undefined;
    for (let index = 0; index < prefixes.length; index += 1) {
      const prefix = prefixes[index];
      if (!prefix) {
        continue;
      }
      try {
        const stat = await this.remote.stat(prefix);
        if ((stat.type & FileType.SymbolicLink) !== 0) {
          throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Symbolic links are denied by confinement policy");
        }
        if (index < prefixes.length - 1 && (stat.type & FileType.Directory) === 0) {
          throw new SftpError(SFTP_STATUS.FAILURE, "Path component is not a directory");
        }
        finalStat = stat;
      } catch (error) {
        if (allowMissingFinal && index === prefixes.length - 1 && isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    }
    return finalStat;
  }
}

export function validateRemoteRoot(remoteRoot: string): string {
  if (!remoteRoot.startsWith("/") || remoteRoot.includes("\0") || remoteRoot.includes("\\")) {
    throw new Error("remote root must be an absolute POSIX path without NUL or backslash");
  }
  const segments = remoteRoot.split("/");
  if (segments.includes("..")) {
    throw new Error("remote root must not contain '..' segments");
  }
  const normalized = posix.normalize(remoteRoot);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function validateClientPath(clientPath: string): string[] {
  if (typeof clientPath !== "string" || clientPath.length === 0 || clientPath.length > 32_768) {
    throw new SftpError(SFTP_STATUS.BAD_MESSAGE, "Malformed path");
  }
  if (clientPath.includes("\0") || clientPath.includes("\\")) {
    throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Ambiguous path separator or NUL denied");
  }
  const segments = clientPath.split("/");
  if (segments.includes("..")) {
    throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Parent traversal denied");
  }
  return segments.filter((segment) => segment !== "" && segment !== ".");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || (root === "/" ? candidate.startsWith("/") : candidate.startsWith(`${root}/`));
}

function pathPrefixes(remotePath: string): string[] {
  const segments = remotePath.split("/").filter(Boolean);
  const prefixes = ["/"];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

function confinedPathPrefixes(root: string, remotePath: string): string[] {
  if (!isWithin(root, remotePath)) {
    throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Path escapes configured root");
  }
  const prefixes = [root];
  const relative = posix.relative(root, remotePath);
  let current = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = posix.join(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}
