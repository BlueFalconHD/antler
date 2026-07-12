import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isHardExcluded, localPath, normalizeRelativePath, TEMPORARY_FILE_PREFIX } from "./paths.js";
import type { TreeEndpoint, TreeEntry } from "./types.js";

export interface LocalTreeOptions {
  readonly root: string;
  readonly shouldIgnore?: (relativePath: string, directory: boolean) => boolean;
}

export class LocalTree implements TreeEndpoint {
  public readonly side = "local" as const;
  public readonly root: string;
  private canonicalRoot = "";

  public constructor(private readonly options: LocalTreeOptions) {
    this.root = path.resolve(options.root);
  }

  public async initialize(): Promise<void> {
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Local sync root must be a non-symlink directory");
    }
    this.canonicalRoot = await fs.realpath(this.root);
    if (this.canonicalRoot === path.parse(this.canonicalRoot).root) {
      throw new Error("Refusing to synchronize a filesystem root");
    }
  }

  public async scan(): Promise<Map<string, TreeEntry>> {
    this.ensureInitialized();
    const result = new Map<string, TreeEntry>();
    const pending = [""];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const absolute = localPath(this.root, directory);
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (isHardExcluded(relative)) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`Symbolic links are not synchronized: ${relative}`);
        }
        if (!entry.isFile() && !entry.isDirectory()) {
          throw new Error(`Special filesystem entries are not synchronized: ${relative}`);
        }
        if (this.options.shouldIgnore?.(relative, entry.isDirectory())) {
          continue;
        }
        const value = await this.stat(relative);
        if (!value) {
          continue;
        }
        result.set(relative, value);
        if (value.kind === "directory") {
          pending.push(relative);
        }
      }
    }
    return result;
  }

  public async stat(relativePath: string): Promise<TreeEntry | undefined> {
    this.ensureInitialized();
    const normalized = normalizeRelativePath(relativePath);
    const absolute = localPath(this.root, normalized);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not synchronized: ${normalized}`);
      }
      const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
      if (!kind) {
        throw new Error(`Special filesystem entries are not synchronized: ${normalized}`);
      }
      await this.verifyInsideRoot(absolute);
      return {
        path: normalized,
        kind,
        size: kind === "file" ? stat.size : 0,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async readFile(relativePath: string): Promise<Buffer> {
    const entry = await this.stat(relativePath);
    if (!entry || entry.kind !== "file") {
      throw new Error(`Local file is unavailable: ${relativePath}`);
    }
    return fs.readFile(localPath(this.root, entry.path));
  }

  public async writeFileAtomic(relativePath: string, content: Buffer): Promise<TreeEntry> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      throw new Error("Cannot replace the local sync root");
    }
    const destination = localPath(this.root, normalized);
    await this.ensureDirectory(path.posix.dirname(normalized) === "." ? "" : path.posix.dirname(normalized));
    await this.verifyInsideRoot(path.dirname(destination));
    let mode = 0o644;
    try {
      const existing = await fs.lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing to replace non-file local path: ${normalized}`);
      }
      mode = existing.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const temporary = path.join(path.dirname(destination), `${TEMPORARY_FILE_PREFIX}${randomUUID()}`);
    const handle = await fs.open(temporary, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await this.verifyInsideRoot(path.dirname(destination));
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const written = await this.stat(normalized);
    if (!written || written.kind !== "file" || written.size !== content.length) {
      throw new Error(`Atomic local write verification failed: ${normalized}`);
    }
    return written;
  }

  public async mkdir(relativePath: string): Promise<TreeEntry> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      const root = await this.stat("");
      if (!root) {
        throw new Error("Local root disappeared");
      }
      return root;
    }
    await this.ensureDirectory(normalized);
    const created = await this.stat(normalized);
    if (!created || created.kind !== "directory") {
      throw new Error(`Local directory creation failed: ${normalized}`);
    }
    return created;
  }

  public async delete(relativePath: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      throw new Error("Cannot delete the local sync root");
    }
    const entry = await this.stat(normalized);
    if (!entry) {
      return;
    }
    const absolute = localPath(this.root, normalized);
    if (entry.kind === "directory") {
      await fs.rmdir(absolute);
    } else {
      await fs.unlink(absolute);
    }
  }

  public async rename(sourcePath: string, destinationPath: string): Promise<TreeEntry> {
    const source = normalizeRelativePath(sourcePath);
    const destination = normalizeRelativePath(destinationPath);
    if (!source || !destination) throw new Error("Cannot rename a sync root");
    const sourceEntry = await this.stat(source);
    if (!sourceEntry) throw new Error(`Local rename source is missing: ${source}`);
    if (await this.stat(destination)) throw new Error(`Local rename destination already exists: ${destination}`);
    const parent = path.posix.dirname(destination) === "." ? "" : path.posix.dirname(destination);
    await this.ensureDirectory(parent);
    const sourceAbsolute = localPath(this.root, source);
    const destinationAbsolute = localPath(this.root, destination);
    await Promise.all([
      this.verifyInsideRoot(path.dirname(sourceAbsolute)),
      this.verifyInsideRoot(path.dirname(destinationAbsolute)),
    ]);
    await fs.rename(sourceAbsolute, destinationAbsolute);
    const renamed = await this.stat(destination);
    if (!renamed || renamed.kind !== sourceEntry.kind) {
      throw new Error(`Local rename verification failed: ${source} -> ${destination}`);
    }
    return renamed;
  }

  private async ensureDirectory(relativePath: string): Promise<void> {
    let current = this.root;
    for (const piece of normalizeRelativePath(relativePath).split("/").filter(Boolean)) {
      current = path.join(current, piece);
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Local parent is not a safe directory: ${relativePath}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        await fs.mkdir(current, { mode: 0o755 });
      }
    }
    await this.verifyInsideRoot(current);
  }

  private async verifyInsideRoot(absolutePath: string): Promise<void> {
    const canonical = await fs.realpath(absolutePath);
    const prefix = this.canonicalRoot.endsWith(path.sep) ? this.canonicalRoot : `${this.canonicalRoot}${path.sep}`;
    if (canonical !== this.canonicalRoot && !canonical.startsWith(prefix)) {
      throw new Error("Local path escapes through a symbolic link");
    }
  }

  private ensureInitialized(): void {
    if (!this.canonicalRoot) {
      throw new Error("Local tree has not been initialized");
    }
  }
}
