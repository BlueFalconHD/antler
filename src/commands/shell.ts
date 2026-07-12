import { createInterface } from "node:readline";
import type { Logger } from "../logging.js";
import { SHELL_HELP, parseShellCommand, type ShellCommand } from "../shell/commands.js";
import type { ProjectRuntime } from "./runtime.js";
import { openProjectRuntime } from "./runtime.js";

type WriteOutput = (value: string) => void;

export async function startProjectShell(
  localRoot: string,
  passwordFile: string | undefined,
  logger: Logger,
  color: boolean,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("antler sh requires an interactive terminal; use individual commands in scripts");
  }
  const runtime = await openProjectRuntime(localRoot, logger, { ...(passwordFile ? { passwordFile } : {}) });
  try {
    logger.success("Authenticated shell ready", {
      remoteRoot: runtime.config.remote.root,
    });
    process.stdout.write("One login, one remote session. Type `help` for commands.\n\n");
    const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    terminal.setPrompt(shellPrompt(color));
    terminal.on("SIGINT", () => {
      process.stdout.write("\n");
      terminal.close();
    });
    terminal.prompt();
    for await (const line of terminal) {
      let exit = false;
      try {
        const command = parseShellCommand(line);
        exit = await executeShellCommand(command, runtime, localRoot, logger, (value) => process.stdout.write(value));
      } catch (error) {
        logger.error("Command failed", { error });
      }
      if (exit) {
        terminal.close();
        break;
      }
      terminal.prompt();
    }
  } finally {
    logger.info("Closing authenticated shell");
    await runtime.close();
  }
}

export async function executeShellCommand(
  command: ShellCommand,
  runtime: ProjectRuntime,
  localRoot: string,
  logger: Logger,
  write: WriteOutput,
): Promise<boolean> {
  switch (command.type) {
    case "empty": return false;
    case "exit": return true;
    case "help":
      write(`${SHELL_HELP}\n`);
      return false;
    case "clear":
      write("\u001b[2J\u001b[H");
      return false;
    case "pwd":
      write(`Local   ${localRoot}\nRemote  ${runtime.config.remote.root}\n`);
      return false;
    case "status":
      await showStatus(runtime, localRoot, write);
      return false;
    case "conflicts":
      showConflicts(runtime, write);
      return false;
    case "sync": {
      const result = await runtime.engine.reconcile({
        approveDeletes: command.approveDeletes,
        forceLargeDelete: command.forceLargeDelete,
      });
      logger.success("Synchronization complete", {
        transferredBytes: result.transferredBytes,
        conflicts: result.conflicts,
        pendingDeletes: result.pendingDeletes,
      });
      return false;
    }
    case "resolve":
      await runtime.engine.resolve(command.path, command.take);
      logger.success(`Conflict resolved using ${command.take}`, { path: command.path });
      return false;
    case "checkpoints":
      await showCheckpoints(runtime, write);
      return false;
    case "restore": {
      requireGit(runtime);
      const safety = await runtime.git.restore(command.checkpoint, command.path);
      logger.success(`Restored ${command.path}`, { preRestoreCheckpoint: safety });
      return false;
    }
    case "doctor":
      await runDoctor(runtime, logger);
      return false;
  }
}

async function showStatus(runtime: ProjectRuntime, localRoot: string, write: WriteOutput): Promise<void> {
  const state = runtime.state.current();
  const git = runtime.gitStatus.available ? await runtime.git.status() : runtime.gitStatus;
  const conflicts = Object.keys(state.conflicts).length;
  const deletions = Object.keys(state.pendingDeletes).length;
  const recovery = Object.keys(state.journal).length;
  write([
    `Local       ${localRoot}`,
    `Remote      ${runtime.config.remote.root}`,
    `Tracked     ${Object.keys(state.entries).length} entries`,
    `Conflicts   ${conflicts}`,
    `Deletions   ${deletions} awaiting approval`,
    `Recovery    ${recovery} interrupted operation(s)`,
    `Last sync   ${state.lastReconciledAt ?? "never"}`,
    `Git         ${git.available ? `${git.branch}${git.dirty ? " (dirty)" : " (clean)"}` : git.reason}`,
  ].join("\n") + "\n");
}

function showConflicts(runtime: ProjectRuntime, write: WriteOutput): void {
  const conflicts = Object.values(runtime.state.current().conflicts)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (conflicts.length === 0) {
    write("No unresolved conflicts.\n");
    return;
  }
  for (const conflict of conflicts) write(`⚠ ${conflict.path}  ${conflict.reason}\n`);
  write("\nResolve with `resolve <path> --take local|remote`.\n");
}

async function showCheckpoints(runtime: ProjectRuntime, write: WriteOutput): Promise<void> {
  requireGit(runtime);
  const checkpoints = await runtime.git.list();
  if (checkpoints.length === 0) {
    write("No safety checkpoints have been created yet.\n");
    return;
  }
  for (const checkpoint of checkpoints) write(`${checkpoint.createdAt}  ${checkpoint.reference}\n`);
}

function requireGit(runtime: ProjectRuntime): void {
  if (!runtime.gitStatus.available) {
    throw new Error(runtime.gitStatus.reason ?? "Git checkpoints are unavailable");
  }
}

async function runDoctor(runtime: ProjectRuntime, logger: Logger): Promise<void> {
  const { client } = await runtime.manager.get();
  const watch = await client.watch(
    runtime.config.remote.root,
    () => undefined,
    (error) => logger.warn("Remote watcher reported an error", { error }),
    ["**/.git/**", "**/.antler/**", "**/.moose_proxy/**"],
  );
  await watch.dispose();
  logger.success("Remote file-change subscription is available");
  const [localEntries, remoteEntries] = await Promise.all([runtime.local.scan(), runtime.remote.scan()]);
  logger.success("Both trees are readable", { localEntries: localEntries.size, remoteEntries: remoteEntries.size });
  logger.success("Doctor found no blocking problems");
}

function shellPrompt(color: boolean): string {
  return color && !("NO_COLOR" in process.env) ? "\u001b[36mantler\u001b[0m › " : "antler > ";
}
