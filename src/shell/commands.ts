import { tokenizeShellLine } from "./tokenize.js";

export type ShellCommand =
  | { readonly type: "empty" }
  | { readonly type: "help" }
  | { readonly type: "exit" }
  | { readonly type: "clear" }
  | { readonly type: "pwd" }
  | { readonly type: "status" }
  | { readonly type: "conflicts" }
  | { readonly type: "sync"; readonly approveDeletes: boolean; readonly forceLargeDelete: boolean }
  | { readonly type: "resolve"; readonly path: string; readonly take: "local" | "remote" }
  | { readonly type: "checkpoints" }
  | { readonly type: "restore"; readonly checkpoint: string; readonly path: string }
  | { readonly type: "doctor" };

export const SHELL_HELP = `Commands
  status                              Show sync, conflict, deletion, and Git state
  sync [--approve-deletes]            Reconcile both trees now
       [--force-large-delete]
  conflicts                           List unresolved conflicts
  resolve <path> --take local|remote  Resolve a conflict and preserve the loser
  checkpoints                         List Git safety checkpoint references
  restore <checkpoint> <path>         Restore a local path through a safety checkpoint
  doctor                              Test the connection, watcher, and both trees
  pwd                                 Show the paired local and remote roots
  clear                               Clear the terminal
  help                                Show this help
  exit                                Disconnect and leave the shell

Paths containing spaces may be quoted. This is a moose-proxy control shell;
it never executes local or remote operating-system commands. Use
\`moose-proxy start\` outside this shell for continuous synchronization.`;

export function parseShellCommand(line: string): ShellCommand {
  const [rawName, ...args] = tokenizeShellLine(line);
  if (!rawName) return { type: "empty" };
  const name = rawName.toLowerCase();
  switch (name) {
    case "?":
    case "help":
      requireCount(name, args, 0);
      return { type: "help" };
    case "exit":
    case "quit":
      requireCount(name, args, 0);
      return { type: "exit" };
    case "clear":
      requireCount(name, args, 0);
      return { type: "clear" };
    case "pwd":
      requireCount(name, args, 0);
      return { type: "pwd" };
    case "status":
      requireCount(name, args, 0);
      return { type: "status" };
    case "conflicts":
      requireCount(name, args, 0);
      return { type: "conflicts" };
    case "sync":
    case "once":
      return parseSync(args);
    case "resolve":
      return parseResolve(args);
    case "checkpoints":
      requireCount(name, args, 0);
      return { type: "checkpoints" };
    case "restore":
      requireCount(name, args, 2);
      return { type: "restore", checkpoint: args[0]!, path: args[1]! };
    case "doctor":
      requireCount(name, args, 0);
      return { type: "doctor" };
    case "init":
      throw new Error("init creates a project and cannot run inside an open project shell");
    case "start":
      throw new Error("start is continuous; exit this shell and run `moose-proxy start`");
    default:
      throw new Error(`Unknown command: ${rawName}. Type \`help\` for available commands.`);
  }
}

function parseSync(args: readonly string[]): ShellCommand {
  const flags = new Set(args);
  for (const argument of flags) {
    if (argument !== "--approve-deletes" && argument !== "--force-large-delete") {
      throw new Error(`Unknown sync option: ${argument}`);
    }
  }
  if (flags.size !== args.length) throw new Error("Sync options must not be repeated");
  if (flags.has("--force-large-delete") && !flags.has("--approve-deletes")) {
    throw new Error("--force-large-delete also requires --approve-deletes");
  }
  return {
    type: "sync",
    approveDeletes: flags.has("--approve-deletes"),
    forceLargeDelete: flags.has("--force-large-delete"),
  };
}

function parseResolve(args: readonly string[]): ShellCommand {
  if (args.length !== 3 || args[1] !== "--take") {
    throw new Error("Usage: resolve <path> --take local|remote");
  }
  const take = args[2];
  if (take !== "local" && take !== "remote") {
    throw new Error("Resolve side must be local or remote");
  }
  return { type: "resolve", path: args[0]!, take };
}

function requireCount(command: string, args: readonly string[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${command} expects ${expected === 0 ? "no arguments" : `${expected} arguments`}`);
  }
}
