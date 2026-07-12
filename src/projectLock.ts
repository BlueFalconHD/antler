import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_DIRECTORY_NAME = "operation.lock";
const OWNER_FILE_NAME = "owner.json";

interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly operation: string;
  readonly startedAt: string;
}

export class ProjectLock {
  private released = false;

  private constructor(
    private readonly directory: string,
    private readonly owner: LockOwner,
  ) {}

  public static async acquire(stateDirectory: string, operation: string): Promise<ProjectLock> {
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const directory = path.join(stateDirectory, LOCK_DIRECTORY_NAME);
    const owner: LockOwner = {
      pid: process.pid,
      hostname: os.hostname(),
      operation,
      startedAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        try {
          await fs.writeFile(path.join(directory, OWNER_FILE_NAME), `${JSON.stringify(owner, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          await fs.rm(directory, { recursive: true, force: true });
          throw error;
        }
        return new ProjectLock(directory, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await readOwner(directory);
      if (!existing || existing.hostname !== owner.hostname || processIsAlive(existing.pid)) {
        throw new Error(lockMessage(existing));
      }

      const staleDirectory = `${directory}.stale-${randomUUID()}`;
      try {
        await fs.rename(directory, staleDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await fs.rm(staleDirectory, { recursive: true, force: true });
    }
    throw new Error("Antler project lock changed repeatedly; retry the operation");
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const existing = await readOwner(this.directory);
    if (existing && existing.pid === this.owner.pid && existing.startedAt === this.owner.startedAt) {
      await fs.rm(this.directory, { recursive: true, force: true });
    }
  }
}

async function readOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, OWNER_FILE_NAME), "utf8"));
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).pid === "number" &&
      typeof (value as Record<string, unknown>).hostname === "string" &&
      typeof (value as Record<string, unknown>).operation === "string" &&
      typeof (value as Record<string, unknown>).startedAt === "string"
    ) {
      return value as LockOwner;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockMessage(owner: LockOwner | undefined): string {
  if (!owner) {
    return "Another Antler operation holds this project lock (owner details unavailable)";
  }
  return (
    `Another Antler operation holds this project lock: ${owner.operation} ` +
    `(pid ${owner.pid} on ${owner.hostname}, started ${owner.startedAt})`
  );
}
