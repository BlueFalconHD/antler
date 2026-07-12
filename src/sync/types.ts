export type EntryKind = "file" | "directory";

export interface EntryFingerprint {
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface TreeEntry extends EntryFingerprint {
  readonly path: string;
}

export interface StoredEntry {
  readonly kind: EntryKind;
  readonly baseHash?: string;
  readonly local: EntryFingerprint;
  readonly remote: EntryFingerprint;
}

export type ConflictReason = "both-modified" | "delete-modify" | "type-mismatch" | "initial-mismatch";

export interface ConflictRecord {
  readonly path: string;
  readonly reason: ConflictReason;
  readonly detectedAt: string;
  readonly localHash?: string;
  readonly remoteHash?: string;
  readonly local?: EntryFingerprint;
  readonly remote?: EntryFingerprint;
}

export interface PendingDelete {
  readonly path: string;
  readonly side: "local" | "remote";
  readonly detectedAt: string;
  readonly expectedHash?: string;
}

export interface JournalRecord {
  readonly id: string;
  readonly action: string;
  readonly path: string;
  readonly startedAt: string;
}

export interface SyncState {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly entries: Record<string, StoredEntry>;
  readonly conflicts: Record<string, ConflictRecord>;
  readonly pendingDeletes: Record<string, PendingDelete>;
  readonly journal: Record<string, JournalRecord>;
  readonly lastReconciledAt?: string;
}

export interface SyncEvent {
  readonly type:
    | "baseline"
    | "upload"
    | "download"
    | "mkdir-local"
    | "mkdir-remote"
    | "delete-local"
    | "delete-remote"
    | "rename-local"
    | "rename-remote"
    | "conflict"
    | "pending-delete"
    | "unchanged";
  readonly path: string;
  readonly bytes?: number;
  readonly durationMs?: number;
  readonly reason?: string;
}

export interface ReconcileResult {
  readonly events: readonly SyncEvent[];
  readonly conflicts: number;
  readonly pendingDeletes: number;
  readonly transferredBytes: number;
}

export interface SyncProgress {
  readonly direction: "upload" | "download";
  readonly path: string;
  readonly transferredBytes: number;
  readonly totalBytes: number;
}

export type ByteProgress = (transferredBytes: number, totalBytes: number) => void;

export interface TreeEndpoint {
  readonly side: "local" | "remote";
  scan(): Promise<Map<string, TreeEntry>>;
  stat(relativePath: string): Promise<TreeEntry | undefined>;
  readFile(relativePath: string, onProgress?: ByteProgress): Promise<Buffer>;
  writeFileAtomic(relativePath: string, content: Buffer, onProgress?: ByteProgress): Promise<TreeEntry>;
  mkdir(relativePath: string): Promise<TreeEntry>;
  delete(relativePath: string): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<TreeEntry>;
}
