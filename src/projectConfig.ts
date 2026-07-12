import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  compatibilityProfiles,
  type CompatibilityProfileName,
} from "./compatibility/profiles.js";
import { STATE_DIRECTORY_NAME, validateRemoteRoot } from "./sync/paths.js";

export interface ProjectConfig {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly remote: {
    readonly url: string;
    readonly root: string;
    readonly profile: CompatibilityProfileName;
    readonly passwordFile?: string;
    readonly rejectUnauthorized: boolean;
    readonly sendOrigin: boolean;
    readonly allowVersionMismatch: boolean;
  };
  readonly sync: {
    readonly deletePolicy: "confirm";
    readonly ignores: readonly string[];
    readonly reconciliationIntervalSeconds: number;
    readonly debounceMilliseconds: number;
    readonly concurrency: number;
  };
  readonly safety: {
    readonly maxDeletes: number;
    readonly maxDeletePercent: number;
  };
  readonly git: {
    readonly enabled: boolean;
    readonly checkpoints: boolean;
  };
}

export interface ParsedConnectionUrl {
  readonly baseUrl: URL;
  readonly remoteRoot?: string;
}

export function parseConnectionUrl(raw: string): ParsedConnectionUrl {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("code-server URL must use http or https");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("code-server URL must not contain credentials or a fragment");
  }
  const inferredRoot = url.searchParams.get("folder") || undefined;
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/login")) {
    url.pathname = `${pathname.slice(0, -"login".length)}`;
  } else if (url.search) {
    throw new Error("A query string is supported only on a pasted code-server /login URL");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  return {
    baseUrl: url,
    ...(inferredRoot ? { remoteRoot: validateRemoteRoot(inferredRoot) } : {}),
  };
}

export function profileForCommit(commit: string): CompatibilityProfileName | undefined {
  return (Object.keys(compatibilityProfiles) as CompatibilityProfileName[]).find(
    (name) => compatibilityProfiles[name].productCommit === commit,
  );
}

export function createProjectConfig(input: {
  readonly projectId?: string;
  readonly url: URL;
  readonly remoteRoot: string;
  readonly profile: CompatibilityProfileName;
  readonly passwordFile?: string;
  readonly rejectUnauthorized?: boolean;
  readonly sendOrigin?: boolean;
  readonly allowVersionMismatch?: boolean;
  readonly gitEnabled?: boolean;
}): ProjectConfig {
  return {
    schemaVersion: 1,
    projectId: input.projectId ?? randomUUID(),
    remote: {
      url: input.url.toString(),
      root: validateRemoteRoot(input.remoteRoot),
      profile: input.profile,
      ...(input.passwordFile ? { passwordFile: path.resolve(input.passwordFile) } : {}),
      rejectUnauthorized: input.rejectUnauthorized ?? true,
      sendOrigin: input.sendOrigin ?? true,
      allowVersionMismatch: input.allowVersionMismatch ?? false,
    },
    sync: {
      deletePolicy: "confirm",
      ignores: [],
      reconciliationIntervalSeconds: 30,
      debounceMilliseconds: 180,
      concurrency: 8,
    },
    safety: {
      maxDeletes: 20,
      maxDeletePercent: 10,
    },
    git: {
      enabled: input.gitEnabled ?? true,
      checkpoints: input.gitEnabled ?? true,
    },
  };
}

export function configPath(localRoot: string): string {
  return path.join(localRoot, STATE_DIRECTORY_NAME, "config.json");
}

export async function saveProjectConfig(localRoot: string, config: ProjectConfig): Promise<void> {
  const stateDirectory = path.join(localRoot, STATE_DIRECTORY_NAME);
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(".moose_proxy must be a non-symlink directory");
  }
  const temporary = path.join(stateDirectory, `.config-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, configPath(localRoot));
}

export async function loadProjectConfig(localRoot: string): Promise<ProjectConfig> {
  const file = configPath(localRoot);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isProjectConfig(value)) {
    throw new Error(`${file} is malformed or uses an unsupported schema`);
  }
  return value;
}

export async function findProjectRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  const startStat = await fs.lstat(current);
  if (!startStat.isDirectory()) {
    current = path.dirname(current);
  }
  while (true) {
    try {
      const stat = await fs.lstat(configPath(current));
      if (stat.isFile() && !stat.isSymbolicLink()) {
        return current;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("No .moose_proxy project found; run moose-proxy init first");
    }
    current = parent;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.projectId !== "string") {
    return false;
  }
  const remote = value.remote;
  const sync = value.sync;
  const safety = value.safety;
  const git = value.git;
  return (
    isObject(remote) &&
    typeof remote.url === "string" &&
    typeof remote.root === "string" &&
    typeof remote.profile === "string" &&
    remote.profile in compatibilityProfiles &&
    typeof remote.rejectUnauthorized === "boolean" &&
    typeof remote.sendOrigin === "boolean" &&
    typeof remote.allowVersionMismatch === "boolean" &&
    (remote.passwordFile === undefined || typeof remote.passwordFile === "string") &&
    isObject(sync) &&
    sync.deletePolicy === "confirm" &&
    Array.isArray(sync.ignores) &&
    sync.ignores.every((entry) => typeof entry === "string") &&
    typeof sync.reconciliationIntervalSeconds === "number" &&
    typeof sync.debounceMilliseconds === "number" &&
    typeof sync.concurrency === "number" &&
    isObject(safety) &&
    typeof safety.maxDeletes === "number" &&
    typeof safety.maxDeletePercent === "number" &&
    isObject(git) &&
    typeof git.enabled === "boolean" &&
    typeof git.checkpoints === "boolean"
  );
}
