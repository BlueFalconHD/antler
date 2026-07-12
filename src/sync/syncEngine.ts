import { randomUUID } from "node:crypto";
import type { GitCheckpoints } from "../git/checkpoints.js";
import { mapLimit } from "./concurrency.js";
import { ObjectStore, contentHash } from "./objectStore.js";
import { normalizeRelativePath, pathDepth } from "./paths.js";
import { StateStore } from "./stateStore.js";
import type {
  ByteProgress,
  ConflictReason,
  EntryFingerprint,
  ReconcileResult,
  StoredEntry,
  SyncEvent,
  SyncProgress,
  TreeEndpoint,
  TreeEntry,
} from "./types.js";

export interface SyncEngineOptions {
  readonly local: TreeEndpoint;
  readonly remote: TreeEndpoint;
  readonly state: StateStore;
  readonly objects: ObjectStore;
  readonly git: GitCheckpoints;
  readonly concurrency: number;
  readonly maxDeletes: number;
  readonly maxDeletePercent: number;
  readonly onEvent?: (event: SyncEvent) => void;
  readonly onProgress?: (progress: SyncProgress) => void;
}

export interface ReconcileOptions {
  readonly paths?: readonly string[];
  readonly approveDeletes?: boolean;
  readonly forceLargeDelete?: boolean;
}

interface StableFile {
  readonly entry: TreeEntry;
  readonly content: Buffer;
  readonly hash: string;
}

interface FileStatus {
  readonly changed: boolean;
  readonly file?: StableFile;
}

interface RunContext {
  readonly events: SyncEvent[];
  checkpoint: Promise<void> | undefined;
  transferredBytes: number;
}

export class SyncEngine {
  public constructor(private readonly options: SyncEngineOptions) {}

  public async reconcile(reconcileOptions: ReconcileOptions = {}): Promise<ReconcileResult> {
    const state = this.options.state.current();
    let paths = reconcileOptions.paths?.map(normalizeRelativePath);
    const forceFull = Object.keys(state.journal).length > 0;
    let localEntries: Map<string, TreeEntry>;
    let remoteEntries: Map<string, TreeEntry>;

    if (!paths || forceFull || (await this.requiresFullScan(paths))) {
      paths = undefined;
      [localEntries, remoteEntries] = await Promise.all([
        this.options.local.scan(),
        this.options.remote.scan(),
      ]);
    } else {
      const unique = [...new Set(paths)];
      const [local, remote] = await Promise.all([
        mapLimit(unique, this.options.concurrency, (entry) => this.options.local.stat(entry)),
        mapLimit(unique, this.options.concurrency, (entry) => this.options.remote.stat(entry)),
      ]);
      localEntries = new Map();
      remoteEntries = new Map();
      for (let index = 0; index < unique.length; index += 1) {
        const key = unique[index]!;
        const localEntry = local[index];
        const remoteEntry = remote[index];
        if (localEntry) localEntries.set(key, localEntry);
        if (remoteEntry) remoteEntries.set(key, remoteEntry);
      }
      paths = unique;
    }

    const keys = new Set(paths ?? [
      ...Object.keys(state.entries),
      ...localEntries.keys(),
      ...remoteEntries.keys(),
    ]);
    const deleteCandidates = [...keys].filter((key) => {
      const stored = state.entries[key];
      return stored && (!localEntries.has(key) || !remoteEntries.has(key));
    });
    if (reconcileOptions.approveDeletes && deleteCandidates.length > 0 && !reconcileOptions.forceLargeDelete) {
      const percent = Object.keys(state.entries).length === 0
        ? 100
        : (deleteCandidates.length / Object.keys(state.entries).length) * 100;
      if (deleteCandidates.length > this.options.maxDeletes || percent > this.options.maxDeletePercent) {
        throw new Error(
          `Delete circuit breaker paused ${deleteCandidates.length} paths (${percent.toFixed(1)}%). ` +
          "Inspect the plan, then repeat with --force-large-delete if it is intentional.",
        );
      }
    }

    const context: RunContext = { events: [], checkpoint: undefined, transferredBytes: 0 };
    const renamed = await this.detectFileRenames(keys, localEntries, remoteEntries, context);
    for (const path of renamed) keys.delete(path);
    const directoryDeletes: Array<{ path: string; side: "local" | "remote" }> = [];
    const directoryKeys = [...keys]
      .filter((key) =>
        localEntries.get(key)?.kind === "directory" ||
        remoteEntries.get(key)?.kind === "directory" ||
        state.entries[key]?.kind === "directory",
      )
      .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
    const directorySet = new Set(directoryKeys);

    for (const key of directoryKeys) {
      const deletion = await this.reconcileDirectory(
        key,
        localEntries.get(key),
        remoteEntries.get(key),
        reconcileOptions.approveDeletes ?? false,
        context,
      );
      if (deletion) directoryDeletes.push(deletion);
    }

    const fileKeys = [...keys]
      .filter((key) => !directorySet.has(key))
      .sort((left, right) => left.localeCompare(right));
    await mapLimit(fileKeys, this.options.concurrency, async (key) => {
      await this.reconcileFile(
        key,
        localEntries.get(key),
        remoteEntries.get(key),
        reconcileOptions.approveDeletes ?? false,
        context,
      );
    });

    for (const deletion of directoryDeletes.sort((left, right) => pathDepth(right.path) - pathDepth(left.path))) {
      await this.performDelete(deletion.path, deletion.side, context);
    }

    await this.options.state.commit((current) => {
      current.lastReconciledAt = new Date().toISOString();
    });
    const current = this.options.state.current();
    return {
      events: context.events,
      conflicts: Object.keys(current.conflicts).length,
      pendingDeletes: Object.keys(current.pendingDeletes).length,
      transferredBytes: context.transferredBytes,
    };
  }

  public async resolve(path: string, take: "local" | "remote"): Promise<SyncEvent> {
    const normalized = normalizeRelativePath(path);
    const conflict = this.options.state.current().conflicts[normalized];
    if (!conflict) {
      throw new Error(`No unresolved conflict exists for ${normalized}`);
    }
    const [local, remote] = await Promise.all([
      this.options.local.stat(normalized),
      this.options.remote.stat(normalized),
    ]);
    if (!sameFingerprint(local, conflict.local) || !sameFingerprint(remote, conflict.remote)) {
      throw new Error("One side changed after this conflict was recorded; reconcile again before resolving it");
    }
    if (!local || !remote || local.kind !== "file" || remote.kind !== "file") {
      throw new Error("Type and deletion conflicts require manual filesystem changes before resolution");
    }
    const context: RunContext = { events: [], checkpoint: undefined, transferredBytes: 0 };
    const source = take === "local" ? this.options.local : this.options.remote;
    const destination = take === "local" ? this.options.remote : this.options.local;
    const stable = await this.readStable(source, normalized);
    const losing = await this.readStable(destination, normalized);
    await this.options.objects.writeConflict(normalized, take === "local" ? "remote" : "local", losing.content);
    if (take === "remote") {
      await this.ensureCheckpoint(context, `resolve-${normalized}`);
    }
    const journalId = await this.beginJournal(`resolve-${take}`, normalized);
    const resolutionProgress = destination.side === "remote" ? this.byteProgress("upload", normalized) : undefined;
    const written = await destination.writeFileAtomic(normalized, stable.content, resolutionProgress);
    const localEntry = take === "local" ? stable.entry : written;
    const remoteEntry = take === "local" ? written : stable.entry;
    await this.storeBaseline(normalized, stable.hash, localEntry, remoteEntry, journalId);
    const event: SyncEvent = {
      type: take === "local" ? "upload" : "download",
      path: normalized,
      bytes: stable.content.length,
      reason: `resolved using ${take}`,
    };
    this.emit(context, event);
    await this.options.state.commit((state) => {
      state.lastReconciledAt = new Date().toISOString();
    });
    return event;
  }

  private async requiresFullScan(paths: readonly string[]): Promise<boolean> {
    const state = this.options.state.current();
    for (const path of paths) {
      if (state.entries[path]?.kind === "directory") {
        return true;
      }
      const [local, remote] = await Promise.all([
        this.options.local.stat(path),
        this.options.remote.stat(path),
      ]);
      if (local?.kind === "directory" || remote?.kind === "directory") {
        return true;
      }
    }
    return false;
  }

  private async reconcileDirectory(
    path: string,
    local: TreeEntry | undefined,
    remote: TreeEntry | undefined,
    approveDeletes: boolean,
    context: RunContext,
  ): Promise<{ path: string; side: "local" | "remote" } | undefined> {
    const stored = this.options.state.current().entries[path];
    if (local && remote) {
      if (local.kind !== "directory" || remote.kind !== "directory") {
        await this.recordConflict(path, "type-mismatch", local, remote, context);
        return undefined;
      }
      await this.storeBaseline(path, undefined, local, remote);
      if (!stored) this.emit(context, { type: "baseline", path });
      return undefined;
    }
    if (!stored) {
      if (local?.kind === "directory" && !remote) {
        const created = await this.options.remote.mkdir(path);
        await this.storeBaseline(path, undefined, local, created);
        this.emit(context, { type: "mkdir-remote", path });
      } else if (remote?.kind === "directory" && !local) {
        const created = await this.options.local.mkdir(path);
        await this.storeBaseline(path, undefined, created, remote);
        this.emit(context, { type: "mkdir-local", path });
      } else if (local || remote) {
        await this.recordConflict(path, "type-mismatch", local, remote, context);
      }
      return undefined;
    }
    if (!local && !remote) {
      await this.removeState(path);
      return undefined;
    }
    if (local && local.kind !== "directory" || remote && remote.kind !== "directory") {
      await this.recordConflict(path, "type-mismatch", local, remote, context);
      return undefined;
    }
    const side = local ? "local" : "remote";
    if (!approveDeletes) {
      await this.recordPendingDelete(path, side, undefined, context);
      return undefined;
    }
    return { path, side };
  }

  private async reconcileFile(
    path: string,
    local: TreeEntry | undefined,
    remote: TreeEntry | undefined,
    approveDeletes: boolean,
    context: RunContext,
  ): Promise<void> {
    const stored = this.options.state.current().entries[path];
    if (local?.kind === "directory" || remote?.kind === "directory") {
      await this.recordConflict(path, "type-mismatch", local, remote, context);
      return;
    }
    if (!stored) {
      await this.reconcileNewFile(path, local, remote, context);
      return;
    }
    if (!local && !remote) {
      await this.removeState(path);
      return;
    }
    if (!local || !remote) {
      const existing = local ?? remote!;
      const endpoint = local ? this.options.local : this.options.remote;
      const previous = local ? stored.local : stored.remote;
      const status = await this.fileStatus(endpoint, path, existing, previous, stored.baseHash);
      if (status.changed) {
        await this.recordConflict(path, "delete-modify", local, remote, context, status.file);
      } else if (!approveDeletes) {
        await this.recordPendingDelete(path, local ? "local" : "remote", stored.baseHash, context);
      } else {
        await this.performDelete(path, local ? "local" : "remote", context);
      }
      return;
    }
    if (stored.kind !== "file") {
      await this.recordConflict(path, "type-mismatch", local, remote, context);
      return;
    }
    const [localStatus, remoteStatus] = await Promise.all([
      this.fileStatus(this.options.local, path, local, stored.local, stored.baseHash),
      this.fileStatus(this.options.remote, path, remote, stored.remote, stored.baseHash),
    ]);
    if (!localStatus.changed && !remoteStatus.changed) {
      await this.storeBaseline(path, stored.baseHash, local, remote);
      return;
    }
    if (localStatus.changed && !remoteStatus.changed) {
      await this.transfer(path, this.options.local, this.options.remote, localStatus.file, context);
      return;
    }
    if (!localStatus.changed && remoteStatus.changed) {
      await this.ensureCheckpoint(context, `download-${path}`);
      await this.transfer(path, this.options.remote, this.options.local, remoteStatus.file, context);
      return;
    }
    const localFile = localStatus.file ?? await this.readStable(this.options.local, path);
    const remoteFile = remoteStatus.file ?? await this.readStable(this.options.remote, path);
    if (localFile.hash === remoteFile.hash) {
      await this.options.objects.put(localFile.content);
      await this.storeBaseline(path, localFile.hash, localFile.entry, remoteFile.entry);
      this.emit(context, { type: "baseline", path, reason: "both sides changed identically" });
      return;
    }
    await this.recordConflict(path, "both-modified", local, remote, context, localFile, remoteFile);
  }

  private async reconcileNewFile(
    path: string,
    local: TreeEntry | undefined,
    remote: TreeEntry | undefined,
    context: RunContext,
  ): Promise<void> {
    if (local && remote) {
      const [localFile, remoteFile] = await Promise.all([
        this.readStable(this.options.local, path),
        this.readStable(this.options.remote, path),
      ]);
      if (localFile.hash === remoteFile.hash) {
        await this.options.objects.put(localFile.content);
        await this.storeBaseline(path, localFile.hash, localFile.entry, remoteFile.entry);
        this.emit(context, { type: "baseline", path });
      } else {
        await this.recordConflict(path, "initial-mismatch", local, remote, context, localFile, remoteFile);
      }
      return;
    }
    if (local) {
      await this.transfer(path, this.options.local, this.options.remote, undefined, context, false);
    } else if (remote) {
      await this.transfer(path, this.options.remote, this.options.local, undefined, context, false);
    }
  }

  private async transfer(
    path: string,
    source: TreeEndpoint,
    destination: TreeEndpoint,
    knownFile: StableFile | undefined,
    context: RunContext,
    journal = true,
  ): Promise<void> {
    const started = performance.now();
    const file = knownFile ?? await this.readStable(source, path);
    await this.options.objects.put(file.content);
    const operation = source.side === "local" ? "upload" : "download";
    const journalId = journal ? await this.beginJournal(operation, path) : undefined;
    await this.ensureDestinationParents(path, source, destination);
    const writeProgress = destination.side === "remote" ? this.byteProgress("upload", path) : undefined;
    const written = await destination.writeFileAtomic(path, file.content, writeProgress);
    const local = source.side === "local" ? file.entry : written;
    const remote = source.side === "remote" ? file.entry : written;
    await this.storeBaseline(path, file.hash, local, remote, journalId);
    context.transferredBytes += file.content.length;
    this.emit(context, {
      type: operation,
      path,
      bytes: file.content.length,
      durationMs: performance.now() - started,
    });
  }

  private async performDelete(
    path: string,
    side: "local" | "remote",
    context: RunContext,
  ): Promise<void> {
    if (side === "local") {
      await this.ensureCheckpoint(context, `delete-${path}`);
    }
    const endpoint = side === "local" ? this.options.local : this.options.remote;
    const journalId = await this.beginJournal(`delete-${side}`, path);
    await endpoint.delete(path);
    this.options.state.mutate((state) => {
      delete state.entries[path];
      delete state.conflicts[path];
      delete state.pendingDeletes[pendingKey(path, side)];
      delete state.journal[journalId];
    });
    this.emit(context, { type: side === "local" ? "delete-local" : "delete-remote", path });
  }

  private async fileStatus(
    endpoint: TreeEndpoint,
    path: string,
    current: TreeEntry,
    previous: EntryFingerprint,
    baseHash: string | undefined,
  ): Promise<FileStatus> {
    if (sameFingerprint(current, previous)) {
      return { changed: false };
    }
    const file = await this.readStable(endpoint, path);
    return { changed: file.hash !== baseHash, file };
  }

  private async readStable(endpoint: TreeEndpoint, path: string): Promise<StableFile> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await endpoint.stat(path);
      if (!before || before.kind !== "file") {
        throw new Error(`${endpoint.side} file changed type during synchronization: ${path}`);
      }
      const readProgress = endpoint.side === "remote" ? this.byteProgress("download", path) : undefined;
      const content = await endpoint.readFile(path, readProgress);
      const after = await endpoint.stat(path);
      if (after && after.kind === "file" && sameFingerprint(before, after) && after.size === content.length) {
        return { entry: after, content, hash: contentHash(content) };
      }
    }
    throw new Error(`${endpoint.side} file kept changing during synchronization: ${path}`);
  }

  private byteProgress(direction: SyncProgress["direction"], path: string): ByteProgress | undefined {
    if (!this.options.onProgress) return undefined;
    return (transferredBytes, totalBytes) => {
      this.options.onProgress?.({ direction, path, transferredBytes, totalBytes });
    };
  }

  private async recordConflict(
    path: string,
    reason: ConflictReason,
    local: TreeEntry | undefined,
    remote: TreeEntry | undefined,
    context: RunContext,
    knownLocal?: StableFile,
    knownRemote?: StableFile,
  ): Promise<void> {
    const existing = this.options.state.current().conflicts[path];
    if (
      existing?.reason === reason &&
      sameFingerprint(local, existing.local) &&
      sameFingerprint(remote, existing.remote)
    ) {
      return;
    }
    const localFile = local?.kind === "file" ? knownLocal ?? await this.readStable(this.options.local, path) : undefined;
    const remoteFile = remote?.kind === "file" ? knownRemote ?? await this.readStable(this.options.remote, path) : undefined;
    if (localFile) await this.options.objects.put(localFile.content);
    if (remoteFile) await this.options.objects.put(remoteFile.content);
    this.options.state.mutate((state) => {
      state.conflicts[path] = {
        path,
        reason,
        detectedAt: new Date().toISOString(),
        ...(localFile ? { localHash: localFile.hash } : {}),
        ...(remoteFile ? { remoteHash: remoteFile.hash } : {}),
        ...(local ? { local: fingerprint(local) } : {}),
        ...(remote ? { remote: fingerprint(remote) } : {}),
      };
      delete state.pendingDeletes[pendingKey(path, "local")];
      delete state.pendingDeletes[pendingKey(path, "remote")];
    });
    this.emit(context, { type: "conflict", path, reason });
  }

  private async recordPendingDelete(
    path: string,
    existingSide: "local" | "remote",
    expectedHash: string | undefined,
    context: RunContext,
  ): Promise<void> {
    const key = pendingKey(path, existingSide);
    const existing = this.options.state.current().pendingDeletes[key];
    if (existing?.expectedHash === expectedHash) {
      return;
    }
    this.options.state.mutate((state) => {
      state.pendingDeletes[key] = {
        path,
        side: existingSide,
        detectedAt: new Date().toISOString(),
        ...(expectedHash ? { expectedHash } : {}),
      };
    });
    this.emit(context, {
      type: "pending-delete",
      path,
      reason: `deleted on ${existingSide === "local" ? "remote" : "local"}; approval required to delete ${existingSide}`,
    });
  }

  private async storeBaseline(
    path: string,
    baseHash: string | undefined,
    local: TreeEntry,
    remote: TreeEntry,
    journalId?: string,
  ): Promise<void> {
    if (local.kind !== remote.kind) {
      throw new Error(`Cannot baseline mismatched types: ${path}`);
    }
    const entry: StoredEntry = {
      kind: local.kind,
      ...(baseHash ? { baseHash } : {}),
      local: fingerprint(local),
      remote: fingerprint(remote),
    };
    const current = this.options.state.current();
    if (
      !journalId &&
      sameStoredEntry(current.entries[path], entry) &&
      !current.conflicts[path] &&
      !current.pendingDeletes[pendingKey(path, "local")] &&
      !current.pendingDeletes[pendingKey(path, "remote")]
    ) {
      return;
    }
    this.options.state.mutate((state) => {
      state.entries[path] = entry;
      delete state.conflicts[path];
      delete state.pendingDeletes[pendingKey(path, "local")];
      delete state.pendingDeletes[pendingKey(path, "remote")];
      if (journalId) delete state.journal[journalId];
    });
  }

  private async removeState(path: string): Promise<void> {
    this.options.state.mutate((state) => {
      delete state.entries[path];
      delete state.conflicts[path];
      delete state.pendingDeletes[pendingKey(path, "local")];
      delete state.pendingDeletes[pendingKey(path, "remote")];
    });
  }

  private async beginJournal(action: string, path: string): Promise<string> {
    const id = randomUUID();
    await this.options.state.recordJournal({ id, action, path, startedAt: new Date().toISOString() });
    return id;
  }

  private async ensureCheckpoint(context: RunContext, label: string): Promise<void> {
    if (!context.checkpoint) {
      context.checkpoint = this.options.git.checkpoint(label).then(() => undefined);
    }
    await context.checkpoint;
  }

  private async detectFileRenames(
    keys: ReadonlySet<string>,
    localEntries: ReadonlyMap<string, TreeEntry>,
    remoteEntries: ReadonlyMap<string, TreeEntry>,
    context: RunContext,
  ): Promise<Set<string>> {
    const state = this.options.state.current();
    const localDeleted = new Map<string, string[]>();
    const remoteDeleted = new Map<string, string[]>();
    const localAdded: string[] = [];
    const remoteAdded: string[] = [];

    for (const path of keys) {
      const stored = state.entries[path];
      const local = localEntries.get(path);
      const remote = remoteEntries.get(path);
      if (!stored && local?.kind === "file" && !remote) localAdded.push(path);
      if (!stored && remote?.kind === "file" && !local) remoteAdded.push(path);
      if (stored?.kind !== "file" || !stored.baseHash) continue;
      if (!local && remote?.kind === "file" && sameFingerprint(remote, stored.remote)) {
        addGrouped(localDeleted, stored.baseHash, path);
      }
      if (!remote && local?.kind === "file" && sameFingerprint(local, stored.local)) {
        addGrouped(remoteDeleted, stored.baseHash, path);
      }
    }

    const consumed = new Set<string>();
    if (localDeleted.size > 0) {
      await this.matchRenames(
        localAdded,
        localDeleted,
        this.options.local,
        this.options.remote,
        localEntries,
        consumed,
        context,
      );
    }
    if (remoteDeleted.size > 0) {
      await this.matchRenames(
        remoteAdded,
        remoteDeleted,
        this.options.remote,
        this.options.local,
        remoteEntries,
        consumed,
        context,
      );
    }
    return consumed;
  }

  private async matchRenames(
    addedPaths: readonly string[],
    deletedByHash: ReadonlyMap<string, readonly string[]>,
    source: TreeEndpoint,
    destination: TreeEndpoint,
    sourceEntries: ReadonlyMap<string, TreeEntry>,
    consumed: Set<string>,
    context: RunContext,
  ): Promise<void> {
    const additions = await mapLimit(addedPaths, this.options.concurrency, async (path) => ({
      path,
      file: await this.readStable(source, path),
    }));
    const additionsByHash = new Map<string, Array<{ path: string; file: StableFile }>>();
    for (const addition of additions) addGrouped(additionsByHash, addition.file.hash, addition);

    for (const [hash, oldPaths] of deletedByHash) {
      const newPaths = additionsByHash.get(hash);
      if (oldPaths.length !== 1 || newPaths?.length !== 1) continue;
      const oldPath = oldPaths[0]!;
      const addition = newPaths[0]!;
      if (consumed.has(oldPath) || consumed.has(addition.path)) continue;
      const sourceEntry = sourceEntries.get(addition.path) ?? addition.file.entry;
      if (destination.side === "local") {
        await this.ensureCheckpoint(context, `rename-${oldPath}`);
      }
      await this.options.objects.put(addition.file.content);
      const journalId = await this.beginJournal(`rename-${destination.side}`, `${oldPath} -> ${addition.path}`);
      await this.ensureDestinationParents(addition.path, source, destination);
      const destinationEntry = await destination.rename(oldPath, addition.path);
      this.options.state.mutate((state) => {
        delete state.entries[oldPath];
        delete state.conflicts[oldPath];
        delete state.pendingDeletes[pendingKey(oldPath, "local")];
        delete state.pendingDeletes[pendingKey(oldPath, "remote")];
      });
      const local = source.side === "local" ? sourceEntry : destinationEntry;
      const remote = source.side === "remote" ? sourceEntry : destinationEntry;
      await this.storeBaseline(addition.path, hash, local, remote, journalId);
      consumed.add(oldPath);
      consumed.add(addition.path);
      this.emit(context, {
        type: destination.side === "local" ? "rename-local" : "rename-remote",
        path: `${oldPath} → ${addition.path}`,
      });
    }
  }

  private async ensureDestinationParents(
    path: string,
    source: TreeEndpoint,
    destination: TreeEndpoint,
  ): Promise<void> {
    const pieces = path.split("/");
    for (let index = 1; index < pieces.length; index += 1) {
      const parent = pieces.slice(0, index).join("/");
      if (await destination.stat(parent)) {
        continue;
      }
      const sourceParent = await source.stat(parent);
      if (!sourceParent || sourceParent.kind !== "directory") {
        throw new Error(`Cannot create missing destination parent: ${parent}`);
      }
      await destination.mkdir(parent);
    }
  }

  private emit(context: RunContext, event: SyncEvent): void {
    context.events.push(event);
    this.options.onEvent?.(event);
  }
}

function fingerprint(entry: EntryFingerprint): EntryFingerprint {
  return {
    kind: entry.kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  };
}

function sameFingerprint(
  left: EntryFingerprint | undefined,
  right: EntryFingerprint | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.kind === right.kind &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function pendingKey(path: string, side: "local" | "remote"): string {
  return `${side}:${path}`;
}

function sameStoredEntry(left: StoredEntry | undefined, right: StoredEntry): boolean {
  return (
    left?.kind === right.kind &&
    left.baseHash === right.baseHash &&
    sameFingerprint(left.local, right.local) &&
    sameFingerprint(left.remote, right.remote)
  );
}

function addGrouped<Value>(map: Map<string, Value[]>, key: string, value: Value): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
