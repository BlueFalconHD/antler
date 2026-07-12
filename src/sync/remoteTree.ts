import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RemoteAgentManager } from "../remoteAgentManager.js";
import { FileType, type RemoteFileSystemClient } from "../vscode/remoteFileSystem.js";
import { isRemoteNotFound } from "../vscode/errors.js";
import { mapLimit } from "./concurrency.js";
import { isHardExcluded, normalizeRelativePath, remotePath, TEMPORARY_FILE_PREFIX, validateRemoteRoot } from "./paths.js";
import { LARGE_FILE_THRESHOLD_BYTES, TRANSFER_CHUNK_BYTES } from "./transferPolicy.js";
import type { ByteProgress, TreeEndpoint, TreeEntry } from "./types.js";

export interface RemoteTreeOptions {
  readonly manager: RemoteAgentManager;
  readonly root: string;
  readonly concurrency?: number;
  readonly shouldIgnore?: (relativePath: string, directory: boolean) => boolean;
}

export class RemoteTree implements TreeEndpoint {
  public readonly side = "remote" as const;
  public readonly root: string;
  private readonly concurrency: number;

  public constructor(private readonly options: RemoteTreeOptions) {
    this.root = validateRemoteRoot(options.root);
    if (this.root === "/") {
      throw new Error("Refusing to synchronize remote filesystem root /");
    }
    this.concurrency = options.concurrency ?? 8;
  }

  public async initialize(): Promise<void> {
    const { client } = await this.options.manager.get();
    const segments = this.root.split("/").filter(Boolean);
    let current = "/";
    for (const segment of segments) {
      current = path.posix.join(current, segment);
      const stat = await client.stat(current);
      if ((stat.type & FileType.SymbolicLink) !== 0 || (stat.type & FileType.Directory) === 0) {
        throw new Error(`Remote root has an unsafe path component: ${current}`);
      }
    }
  }

  public async scan(): Promise<Map<string, TreeEntry>> {
    const { client, generation } = await this.options.manager.get();
    const result = new Map<string, TreeEntry>();
    const pending = [""];
    while (pending.length > 0) {
      this.options.manager.assertGeneration(generation);
      const directory = pending.shift()!;
      const entries = await client.readdir(remotePath(this.root, directory));
      const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
      const scanned = await mapLimit(sorted, this.concurrency, async (entry) => {
        if (entry.name.includes("/") || entry.name.includes("\\") || entry.name === "." || entry.name === "..") {
          throw new Error("Remote directory returned an unsafe entry name");
        }
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (isHardExcluded(relative)) {
          return undefined;
        }
        const value = await this.statWithClient(client, relative);
        if (value && this.options.shouldIgnore?.(relative, value.kind === "directory")) {
          return undefined;
        }
        return value;
      });
      for (const entry of scanned) {
        if (!entry) {
          continue;
        }
        result.set(entry.path, entry);
        if (entry.kind === "directory") {
          pending.push(entry.path);
        }
      }
    }
    return result;
  }

  public async stat(relativePath: string): Promise<TreeEntry | undefined> {
    const { client } = await this.options.manager.get();
    return this.statWithClient(client, relativePath);
  }

  public async readFile(relativePath: string, onProgress?: ByteProgress): Promise<Buffer> {
    const normalized = normalizeRelativePath(relativePath);
    const entry = await this.verifyExisting(normalized, "file");
    const { client } = await this.options.manager.get();
    const absolute = remotePath(this.root, normalized);
    if (onProgress && entry.size >= LARGE_FILE_THRESHOLD_BYTES) {
      return client.readFileChunked(absolute, entry.size, TRANSFER_CHUNK_BYTES, onProgress);
    }
    const content = await client.readFile(absolute);
    onProgress?.(content.length, entry.size);
    return content;
  }

  public async writeFileAtomic(relativePath: string, content: Buffer, onProgress?: ByteProgress): Promise<TreeEntry> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      throw new Error("Cannot replace the remote sync root");
    }
    const parent = path.posix.dirname(normalized) === "." ? "" : path.posix.dirname(normalized);
    await this.verifyExisting(parent, "directory");
    const { client, generation } = await this.options.manager.get();
    const destination = remotePath(this.root, normalized);
    const temporary = path.posix.join(path.posix.dirname(destination), `${TEMPORARY_FILE_PREFIX}${randomUUID()}`);
    try {
      if (onProgress && content.length >= LARGE_FILE_THRESHOLD_BYTES) {
        await client.writeFileChunked(temporary, content, TRANSFER_CHUNK_BYTES, onProgress);
      } else {
        await client.writeFile(temporary, content, false);
        onProgress?.(content.length, content.length);
      }
      this.options.manager.assertGeneration(generation);
      const staged = await client.stat(temporary);
      if ((staged.type & FileType.File) === 0 || staged.size !== content.length) {
        throw new Error(`Remote staging verification failed: ${normalized}`);
      }
      await this.verifyExisting(parent, "directory");
      await client.rename(temporary, destination, true);
    } catch (error) {
      try {
        await client.delete(temporary, false);
      } catch {
        // The destination is still protected by atomic rename; cleanup is best-effort.
      }
      throw error;
    }
    const written = await this.stat(normalized);
    if (!written || written.kind !== "file" || written.size !== content.length) {
      throw new Error(`Atomic remote write verification failed: ${normalized}`);
    }
    return written;
  }

  public async mkdir(relativePath: string): Promise<TreeEntry> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      const root = await this.stat("");
      if (!root) {
        throw new Error("Remote root disappeared");
      }
      return root;
    }
    const parent = path.posix.dirname(normalized) === "." ? "" : path.posix.dirname(normalized);
    await this.verifyExisting(parent, "directory");
    const { client } = await this.options.manager.get();
    try {
      await client.mkdir(remotePath(this.root, normalized));
    } catch (error) {
      const existing = await this.stat(normalized);
      if (!existing || existing.kind !== "directory") {
        throw error;
      }
    }
    const created = await this.stat(normalized);
    if (!created || created.kind !== "directory") {
      throw new Error(`Remote directory creation failed: ${normalized}`);
    }
    return created;
  }

  public async delete(relativePath: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      throw new Error("Cannot delete the remote sync root");
    }
    const entry = await this.stat(normalized);
    if (!entry) {
      return;
    }
    const { client } = await this.options.manager.get();
    await client.delete(remotePath(this.root, normalized), false);
  }

  public async rename(sourcePath: string, destinationPath: string): Promise<TreeEntry> {
    const source = normalizeRelativePath(sourcePath);
    const destination = normalizeRelativePath(destinationPath);
    if (!source || !destination) throw new Error("Cannot rename a sync root");
    const sourceEntry = await this.stat(source);
    if (!sourceEntry) throw new Error(`Remote rename source is missing: ${source}`);
    if (await this.stat(destination)) throw new Error(`Remote rename destination already exists: ${destination}`);
    const destinationParent = path.posix.dirname(destination) === "." ? "" : path.posix.dirname(destination);
    await this.verifyExisting(destinationParent, "directory");
    await this.verifyExisting(source, sourceEntry.kind);
    const { client } = await this.options.manager.get();
    await client.rename(remotePath(this.root, source), remotePath(this.root, destination), false);
    const renamed = await this.stat(destination);
    if (!renamed || renamed.kind !== sourceEntry.kind) {
      throw new Error(`Remote rename verification failed: ${source} -> ${destination}`);
    }
    return renamed;
  }

  private async statWithClient(client: RemoteFileSystemClient, relativePath: string): Promise<TreeEntry | undefined> {
    const normalized = normalizeRelativePath(relativePath);
    try {
      const stat = await client.stat(remotePath(this.root, normalized));
      if ((stat.type & FileType.SymbolicLink) !== 0) {
        throw new Error(`Symbolic links are not synchronized: ${normalized}`);
      }
      const kind = (stat.type & FileType.File) !== 0 ? "file" : (stat.type & FileType.Directory) !== 0 ? "directory" : undefined;
      if (!kind) {
        throw new Error(`Special remote filesystem entries are not synchronized: ${normalized}`);
      }
      return {
        path: normalized,
        kind,
        size: kind === "file" ? stat.size : 0,
        mtimeMs: stat.mtime,
        ctimeMs: stat.ctime,
      };
    } catch (error) {
      if (isRemoteNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async verifyExisting(relativePath: string, expected: "file" | "directory"): Promise<TreeEntry> {
    const normalized = normalizeRelativePath(relativePath);
    const pieces = normalized.split("/").filter(Boolean);
    let target: TreeEntry | undefined;
    for (let index = 0; index <= pieces.length; index += 1) {
      const current = pieces.slice(0, index).join("/");
      const entry = await this.stat(current);
      if (!entry || entry.kind !== (index === pieces.length ? expected : "directory")) {
        throw new Error(`Remote path is not a safe ${index === pieces.length ? expected : "directory"}: ${current}`);
      }
      target = entry;
    }
    return target!;
  }
}
