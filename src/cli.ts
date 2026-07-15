import path from "node:path";
import { Command, Option } from "commander";
import packageMetadata from "../package.json" with { type: "json" };
import { setDeletePolicy } from "./commands/config.js";
import { doctorProject } from "./commands/doctor.js";
import { initializeProject, type InitOptions } from "./commands/init.js";
import { resolveConflict } from "./commands/resolve.js";
import { startProjectShell } from "./commands/shell.js";
import { startProject } from "./commands/start.js";
import { listCheckpoints, listConflicts, projectStatus, restoreCheckpoint } from "./commands/status.js";
import { syncProjectOnce } from "./commands/sync.js";
import { Logger, type LogFormat, type LogLevel } from "./logging.js";
import { findProjectRoot, type DeletePolicy } from "./projectConfig.js";

interface GlobalOptions {
  readonly format: LogFormat;
  readonly logLevel: LogLevel;
  readonly color: boolean;
}

interface PasswordOptions {
  readonly passwordFile?: string;
}

const PASSWORD_ARGUMENT_GUIDANCE =
  "Antler does not accept raw passwords as command-line arguments because they may be exposed " +
  "in shell history and process listings. Omit the password to enter it at the hidden prompt, " +
  "or use --password-file or ANTLER_CODE_SERVER_PASSWORD for automation.";

export function rejectRawPasswordOption(argv: readonly string[]): void {
  if (argv.slice(2).some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    throw new Error(PASSWORD_ARGUMENT_GUIDANCE);
  }
}

export function rejectUnexpectedInitArguments(arguments_: readonly string[]): void {
  if (arguments_.length > 1) {
    throw new Error(`Unexpected extra init argument. ${PASSWORD_ARGUMENT_GUIDANCE}`);
  }
}

function loggerFor(program: Command): Logger {
  const options = program.opts<GlobalOptions>();
  return new Logger(options.logLevel, { format: options.format, color: options.color });
}

async function existingRoot(directory: string): Promise<string> {
  return findProjectRoot(path.resolve(directory));
}

export async function runCli(argv: readonly string[]): Promise<void> {
  rejectRawPasswordOption(argv);
  const effectiveArguments = argv.length === 2 ? [...argv, "start"] : [...argv];
  const program = new Command()
    .name("antler")
    .version(packageMetadata.version)
    .description("Local-first datapack synchronization for Legitimoose")
    .addOption(new Option("--format <format>", "diagnostic output style").choices(["pretty", "plain", "json"]).default(process.stderr.isTTY ? "pretty" : "plain"))
    .addOption(new Option("--log-level <level>", "diagnostic detail").choices(["debug", "info", "warn", "error"]).default("info"))
    .option("--no-color", "disable terminal colors")
    .showHelpAfterError();

  program
    .command("init")
    .description("Connect a local datapack directory to Legitimoose safely")
    .argument("[directory]", "local project directory", ".")
    .option("--sync-root <path>", "project-relative directory synchronized with the remote", ".")
    .option("--url <url>", "full browser workspace URL, including the folder query parameter")
    .option("--remote-root <path>", "remote project directory (inferred from the browser URL)")
    .option("--password-file <path>", "file containing the code-server password")
    .option("--insecure-skip-tls-verify", "DEVELOPMENT ONLY: disable TLS certificate verification")
    .option("--omit-origin", "omit the browser-equivalent WebSocket Origin header")
    .option("--allow-version-mismatch", "continue after an explicit Legitimoose version mismatch")
    .option("--no-git", "disable Git safety checkpoints")
    .addOption(new Option("--delete-policy <policy>", "deletion policy: confirm or allow").choices(["confirm", "allow"]).default("confirm"))
    .allowExcessArguments()
    .addHelpText(
      "after",
      "\nThe password is requested in a hidden prompt. For automation, use --password-file " +
      "or ANTLER_CODE_SERVER_PASSWORD; never put the raw password in the command.\n",
    )
    .action(async (directory: string, options: InitOptions, command: Command) => {
      rejectUnexpectedInitArguments(command.args);
      await initializeProject(directory, options, loggerFor(program));
    });

  program
    .command("start")
    .description("Watch both trees and synchronize changes until stopped")
    .argument("[directory]", "project directory or any child", ".")
    .option("--password-file <path>", "override the configured password file")
    .action(async (directory: string, options: PasswordOptions) => {
      await startProject(await existingRoot(directory), options.passwordFile, loggerFor(program));
    });

  program
    .command("sh")
    .description("Open one authenticated interactive Antler control session")
    .argument("[directory]", "project directory or any child", ".")
    .option("--password-file <path>", "override the configured password file")
    .action(async (directory: string, options: PasswordOptions) => {
      const global = program.opts<GlobalOptions>();
      await startProjectShell(await existingRoot(directory), options.passwordFile, loggerFor(program), global.color);
    });

  program
    .command("sync")
    .alias("once")
    .description("Reconcile both trees once and exit")
    .argument("[directory]", "project directory or any child", ".")
    .option("--password-file <path>", "override the configured password file")
    .option("--approve-deletes", "propagate reviewed one-sided deletions")
    .option("--force-large-delete", "override the delete-count circuit breaker")
    .action(async (directory: string, options: PasswordOptions & { approveDeletes?: boolean; forceLargeDelete?: boolean }) => {
      await syncProjectOnce(await existingRoot(directory), options, loggerFor(program));
    });

  program
    .command("status")
    .description("Show local state, conflicts, pending deletions, and Git safety status")
    .argument("[directory]", "project directory or any child", ".")
    .action(async (directory: string) => {
      await projectStatus(await existingRoot(directory), program.opts<GlobalOptions>().format === "json");
    });

  program
    .command("config")
    .description("Update project synchronization settings")
    .argument("[directory]", "project directory or any child", ".")
    .addOption(new Option("--delete-policy <policy>", "deletion policy: confirm or allow").choices(["confirm", "allow"]).makeOptionMandatory())
    .action(async (directory: string, options: { deletePolicy: DeletePolicy }) => {
      await setDeletePolicy(await existingRoot(directory), options.deletePolicy, loggerFor(program));
    });

  program
    .command("conflicts")
    .description("List files that changed differently on both sides")
    .argument("[directory]", "project directory or any child", ".")
    .action(async (directory: string) => {
      await listConflicts(await existingRoot(directory), program.opts<GlobalOptions>().format === "json");
    });

  program
    .command("resolve")
    .description("Resolve one conflict while preserving the discarded version")
    .argument("<path>", "root-relative conflicted path")
    .argument("[directory]", "project directory or any child", ".")
    .requiredOption("--take <side>", "version to keep: local or remote")
    .option("--password-file <path>", "override the configured password file")
    .action(async (conflictPath: string, directory: string, options: PasswordOptions & { take: string }) => {
      if (options.take !== "local" && options.take !== "remote") {
        throw new Error("--take must be local or remote");
      }
      await resolveConflict(
        await existingRoot(directory),
        conflictPath,
        options.take,
        options.passwordFile,
        loggerFor(program),
      );
    });

  program
    .command("checkpoints")
    .description("List hidden Git safety snapshots created before inbound changes")
    .argument("[directory]", "project directory or any child", ".")
    .action(async (directory: string) => {
      await listCheckpoints(await existingRoot(directory), program.opts<GlobalOptions>().format === "json");
    });

  program
    .command("restore")
    .description("Restore one local path from a safety checkpoint without changing the Git index")
    .argument("<checkpoint>", "full refs/antler/checkpoints/... reference")
    .argument("<path>", "root-relative file path")
    .option("--project <directory>", "project directory or any child", ".")
    .action(async (checkpoint: string, relativePath: string, options: { project: string }) => {
      const safety = await restoreCheckpoint(await existingRoot(options.project), checkpoint, relativePath);
      loggerFor(program).success(`Restored ${relativePath}`, { preRestoreCheckpoint: safety });
    });

  program
    .command("doctor")
    .description("Verify authentication, confinement, remote events, and tree access")
    .argument("[directory]", "project directory or any child", ".")
    .option("--password-file <path>", "override the configured password file")
    .action(async (directory: string, options: PasswordOptions) => {
      await doctorProject(await existingRoot(directory), options.passwordFile, loggerFor(program));
    });

  await program.parseAsync(effectiveArguments);
}
