import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SyncState } from "./types.js";

export const STATE_FILE_NAME = "state.json";

export class StateStore {
  private state: SyncState | undefined;
  private writes: Promise<void> = Promise.resolve();

  public constructor(public readonly directory: string) {}

  public async initialize(projectId: string = randomUUID()): Promise<SyncState> {
    await this.ensureDirectory();
    try {
      await fs.lstat(this.filePath());
      throw new Error(`Sync state already exists at ${this.filePath()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.state = {
      schemaVersion: 1,
      projectId,
      entries: {},
      conflicts: {},
      pendingDeletes: {},
      journal: {},
    };
    await this.persist();
    return this.state;
  }

  public async load(): Promise<SyncState> {
    await this.ensureDirectory(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`No sync state found at ${this.filePath()}; run moose-proxy init first`);
      }
      throw new Error(`Unable to read sync state safely: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isSyncState(parsed)) {
      throw new Error("Sync state is malformed or uses an unsupported schema; no files were changed");
    }
    this.state = parsed;
    return parsed;
  }

  public current(): SyncState {
    if (!this.state) {
      throw new Error("Sync state has not been loaded");
    }
    return this.state;
  }

  public update(mutator: (state: MutableSyncState) => void): Promise<void> {
    const run = this.writes.then(async () => {
      const state = this.current();
      mutator(state as MutableSyncState);
      await this.writeAtomic(state);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  public async flush(): Promise<void> {
    await this.writes;
  }

  private persist(): Promise<void> {
    return this.writeAtomic(this.current());
  }

  private async ensureDirectory(create = true): Promise<void> {
    if (create) {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(".moose_proxy must be a non-symlink directory");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      await fs.chmod(this.directory, 0o700);
    }
  }

  private filePath(): string {
    return path.join(this.directory, STATE_FILE_NAME);
  }

  private async writeAtomic(state: SyncState): Promise<void> {
    await this.ensureDirectory();
    const temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.filePath());
  }
}

type MutableSyncState = {
  -readonly [Key in keyof SyncState]: SyncState[Key];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSyncState(value: unknown): value is SyncState {
  if (!isObject(value)) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.projectId === "string" &&
    isObject(value.entries) &&
    isObject(value.conflicts) &&
    isObject(value.pendingDeletes) &&
    isObject(value.journal)
  );
}
