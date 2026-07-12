import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isLocalPathInside, normalizeLocalRelativePath } from "../sync/paths.js";

const CHECKPOINT_PREFIX = "refs/antler/checkpoints/";
const LEGACY_CHECKPOINT_PREFIX = "refs/moose-proxy/checkpoints/";

export interface GitStatus {
  readonly available: boolean;
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly reason?: string;
}

export interface GitCheckpoint {
  readonly reference: string;
  readonly commit: string;
  readonly createdAt: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class GitCheckpoints {
  private repositoryRoot: string | undefined;
  private syncPathspec: string | undefined;
  private statePathspec: string | undefined;

  public constructor(
    private readonly projectRoot: string,
    private readonly syncRoot: string,
    private readonly stateDirectory: string,
    private readonly enabled: boolean,
  ) {}

  public async initialize(): Promise<GitStatus> {
    if (!this.enabled) {
      return { available: false, reason: "disabled by project configuration" };
    }
    const top = await runGit(this.projectRoot, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      return { available: false, reason: "local directory is not a Git repository" };
    }
    this.repositoryRoot = await fs.realpath(path.resolve(top.stdout.trim()));
    const resolvedProjectRoot = path.resolve(this.projectRoot);
    const canonicalProjectRoot = await fs.realpath(resolvedProjectRoot);
    const canonicalSyncRoot = await fs.realpath(path.resolve(this.syncRoot));
    if (!isLocalPathInside(this.repositoryRoot, canonicalSyncRoot)) {
      this.repositoryRoot = undefined;
      return { available: false, reason: "checkpoints require the sync root to be inside the Git repository" };
    }
    this.syncPathspec = gitRelativePath(this.repositoryRoot, canonicalSyncRoot);
    const canonicalStateDirectory = path.resolve(
      canonicalProjectRoot,
      path.relative(resolvedProjectRoot, path.resolve(this.stateDirectory)),
    );
    this.statePathspec = gitRelativePath(this.repositoryRoot, canonicalStateDirectory);
    await this.excludeStateDirectory();
    return this.status();
  }

  public async status(): Promise<GitStatus> {
    if (!this.repositoryRoot) {
      return { available: false, reason: "Git checkpoints are unavailable" };
    }
    const [branch, changes] = await Promise.all([
      runGit(this.repositoryRoot, ["branch", "--show-current"]),
      runGit(this.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    return {
      available: true,
      branch: branch.stdout.trim() || "detached HEAD",
      dirty: changes.stdout.length > 0,
    };
  }

  public async checkpoint(label: string): Promise<string | undefined> {
    if (!this.repositoryRoot) {
      return undefined;
    }
    await fs.mkdir(path.join(this.stateDirectory, "tmp"), { recursive: true, mode: 0o700 });
    const index = path.join(this.stateDirectory, "tmp", `git-index-${randomUUID()}`);
    const environment = {
      ...process.env,
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: "Antler",
      GIT_AUTHOR_EMAIL: "antler@localhost",
      GIT_COMMITTER_NAME: "Antler",
      GIT_COMMITTER_EMAIL: "antler@localhost",
    };
    try {
      await mustGit(this.repositoryRoot, ["read-tree", "--empty"], environment);
      await mustGit(this.repositoryRoot, ["add", "-A", "--", "."], environment);
      if (this.syncPathspec && this.syncPathspec !== ".") {
        await mustGit(this.repositoryRoot, ["add", "-f", "-A", "--", this.syncPathspec], environment);
      }
      const excludedStatePaths = this.statePathspec
        ? [this.statePathspec, legacyStatePath(this.statePathspec)]
        : [];
      await mustGit(
        this.repositoryRoot,
        ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", ...excludedStatePaths],
        environment,
      );
      const tree = (await mustGit(this.repositoryRoot, ["write-tree"], environment)).stdout.trim();
      const head = await runGit(this.repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
      const commitArguments = ["commit-tree", tree];
      if (head.code === 0) {
        commitArguments.push("-p", head.stdout.trim());
      }
      const commit = (
        await mustGit(
          this.repositoryRoot,
          commitArguments,
          environment,
          `Antler safety checkpoint: ${label}\n`,
        )
      ).stdout.trim();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "sync";
      const reference = `${CHECKPOINT_PREFIX}${timestamp}-${safeLabel}-${randomUUID().slice(0, 8)}`;
      await mustGit(this.repositoryRoot, ["update-ref", reference, commit, ""]);
      return reference;
    } finally {
      await fs.rm(index, { force: true });
    }
  }

  public async list(): Promise<readonly GitCheckpoint[]> {
    if (!this.repositoryRoot) return [];
    const result = await mustGit(this.repositoryRoot, [
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname)%09%(objectname)%09%(creatordate:iso8601-strict)",
      CHECKPOINT_PREFIX,
      LEGACY_CHECKPOINT_PREFIX,
    ]);
    return result.stdout.split("\n").filter(Boolean).map((line) => {
      const [reference, commit, createdAt] = line.split("\t");
      if (!reference || !commit || !createdAt) throw new Error("Git returned a malformed checkpoint record");
      return { reference, commit, createdAt };
    });
  }

  public async restore(reference: string, relativePath: string): Promise<string> {
    if (!this.repositoryRoot) throw new Error("Git checkpoints are unavailable for this project");
    if (!reference.startsWith(CHECKPOINT_PREFIX) && !reference.startsWith(LEGACY_CHECKPOINT_PREFIX)) {
      throw new Error(`Restore source must be a ${CHECKPOINT_PREFIX} reference`);
    }
    const normalized = normalizeLocalRelativePath(relativePath);
    if (!normalized) throw new Error("Restoring the entire sync root is not allowed");
    const repositoryPath = this.repositoryPath(normalized);
    await mustGit(this.repositoryRoot, ["cat-file", "-e", `${reference}:${repositoryPath}`]);
    const safety = await this.checkpoint(`before-restore-${normalized}`);
    if (!safety) throw new Error("Unable to create the pre-restore safety checkpoint");
    await mustGit(this.repositoryRoot, ["restore", "--source", reference, "--worktree", "--", repositoryPath]);
    return safety;
  }

  private async excludeStateDirectory(): Promise<void> {
    if (!this.repositoryRoot) {
      return;
    }
    const gitPath = await mustGit(this.repositoryRoot, ["rev-parse", "--git-path", "info/exclude"]);
    const excludeFile = path.resolve(this.repositoryRoot, gitPath.stdout.trim());
    let contents = "";
    try {
      contents = await fs.readFile(excludeFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (!this.statePathspec) return;
    const excludeEntry = `${this.statePathspec}/`;
    if (!contents.split(/\r?\n/).includes(excludeEntry)) {
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
      await fs.appendFile(excludeFile, `${contents && !contents.endsWith("\n") ? "\n" : ""}${excludeEntry}\n`);
    }
  }

  private repositoryPath(syncRelativePath: string): string {
    if (!this.syncPathspec) throw new Error("Git checkpoints are unavailable for this project");
    return this.syncPathspec === "."
      ? syncRelativePath
      : path.posix.join(this.syncPathspec, syncRelativePath);
  }
}

function gitRelativePath(repositoryRoot: string, candidate: string): string | undefined {
  if (!isLocalPathInside(repositoryRoot, candidate)) return undefined;
  const relative = path.relative(repositoryRoot, candidate);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function legacyStatePath(statePathspec: string): string {
  const parent = path.posix.dirname(statePathspec);
  return parent === "." ? ".moose_proxy" : path.posix.join(parent, ".moose_proxy");
}

async function mustGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  input?: string,
): Promise<CommandResult> {
  const result = await runGit(cwd, args, environment, input);
  if (result.code !== 0) {
    throw new Error(`Git checkpoint failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  input?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: environment,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      });
    });
    if (input !== undefined) {
      child.stdin!.end(input);
    }
  });
}
