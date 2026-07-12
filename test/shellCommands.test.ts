import { describe, expect, it, vi } from "vitest";
import { executeShellCommand } from "../src/commands/shell.js";
import { Logger } from "../src/logging.js";
import type { ProjectRuntime } from "../src/commands/runtime.js";
import { parseShellCommand } from "../src/shell/commands.js";
import { tokenizeShellLine } from "../src/shell/tokenize.js";

describe("interactive shell tokenizer", () => {
  it("supports safely quoted paths without evaluating shell syntax", () => {
    expect(tokenizeShellLine('resolve "data/my file.json" --take remote')).toEqual([
      "resolve",
      "data/my file.json",
      "--take",
      "remote",
    ]);
    expect(tokenizeShellLine("restore 'refs/antler/check point' path\\ with\\ spaces.txt")).toEqual([
      "restore",
      "refs/antler/check point",
      "path with spaces.txt",
    ]);
    expect(tokenizeShellLine("sync $(touch nope)")).toEqual(["sync", "$(touch", "nope)"]);
  });

  it.each(["resolve 'unfinished", "status \\"])("rejects incomplete input: %s", (line) => {
    expect(() => tokenizeShellLine(line)).toThrow(/unterminated|incomplete/);
  });
});

describe("interactive shell command parsing", () => {
  it("parses synchronization safety flags", () => {
    expect(parseShellCommand("sync --approve-deletes --force-large-delete")).toEqual({
      type: "sync",
      approveDeletes: true,
      forceLargeDelete: true,
    });
    expect(parseShellCommand("once")).toEqual({
      type: "sync",
      approveDeletes: false,
      forceLargeDelete: false,
    });
  });

  it("parses conflict resolution and restores with quoted paths", () => {
    expect(parseShellCommand('resolve "data/my file.json" --take local')).toEqual({
      type: "resolve",
      path: "data/my file.json",
      take: "local",
    });
    expect(parseShellCommand('restore refs/antler/checkpoints/example "data/my file.json"')).toEqual({
      type: "restore",
      checkpoint: "refs/antler/checkpoints/example",
      path: "data/my file.json",
    });
  });

  it.each([
    "sync --unknown",
    "sync --force-large-delete",
    "resolve file.txt --take neither",
    "resolve file.txt local",
    "start",
    "unknown",
  ])("rejects unsafe or unsupported input: %s", (line) => {
    expect(() => parseShellCommand(line)).toThrow();
  });

  it.each(["help", "?", "status", "conflicts", "checkpoints", "doctor", "pwd", "clear", "exit", "quit"])(
    "accepts %s",
    (line) => expect(() => parseShellCommand(line)).not.toThrow(),
  );
});

describe("interactive shell dispatch", () => {
  it("reuses the supplied runtime for repeated commands", async () => {
    const reconcile = vi.fn().mockResolvedValue({
      events: [],
      conflicts: 0,
      pendingDeletes: 0,
      transferredBytes: 12,
    });
    const runtime = {
      config: { remote: { root: "/srv/project" } },
      paths: {
        projectRoot: "/tmp/project",
        stateDirectory: "/tmp/project/.antler",
        syncRoot: "/tmp/project",
      },
      engine: { reconcile },
    } as unknown as ProjectRuntime;
    const logger = new Logger("error", { format: "plain", color: false });
    let output = "";
    const write = (value: string) => { output += value; };

    expect(await executeShellCommand(parseShellCommand("pwd"), runtime, "/tmp/project", logger, write)).toBe(false);
    expect(await executeShellCommand(parseShellCommand("sync"), runtime, "/tmp/project", logger, write)).toBe(false);
    expect(await executeShellCommand(parseShellCommand("exit"), runtime, "/tmp/project", logger, write)).toBe(true);

    expect(output).toContain("Local   /tmp/project");
    expect(output).toContain("Remote  /srv/project");
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
