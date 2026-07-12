import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCheckpoints } from "../src/git/checkpoints.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("Git safety checkpoints", () => {
  it("creates a hidden reachable snapshot without touching HEAD or the real index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-git-"));
    roots.push(root);
    await execute("git", ["init", "-q", root]);
    await fs.writeFile(path.join(root, "tracked.txt"), "base");
    await execute("git", ["-C", root, "add", "tracked.txt"]);
    await execute("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await fs.writeFile(path.join(root, "tracked.txt"), "modified");
    await fs.writeFile(path.join(root, "untracked.txt"), "new");
    const beforeHead = (await execute("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const beforeStatus = (await execute("git", ["-C", root, "status", "--porcelain"])).stdout;
    const checkpoints = new GitCheckpoints(root, path.join(root, ".antler"), true);
    expect((await checkpoints.initialize()).available).toBe(true);
    const reference = await checkpoints.checkpoint("inbound-test");
    expect(reference).toMatch(/^refs\/antler\/checkpoints\//);
    expect((await execute("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(beforeHead);
    expect((await execute("git", ["-C", root, "status", "--porcelain"])).stdout).toBe(beforeStatus);
    const names = (await execute("git", ["-C", root, "ls-tree", "-r", "--name-only", reference!])).stdout;
    expect(names).toContain("tracked.txt");
    expect(names).toContain("untracked.txt");
    expect(names).not.toContain(".antler");
    expect((await checkpoints.list())[0]?.reference).toBe(reference);
    const exclude = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split(/\r?\n/)).toContain(".antler/");

    const commit = (await execute("git", ["-C", root, "rev-parse", reference!])).stdout.trim();
    const legacyReference = "refs/moose-proxy/checkpoints/legacy-test";
    await execute("git", ["-C", root, "update-ref", legacyReference, commit]);
    expect((await checkpoints.list()).map((checkpoint) => checkpoint.reference)).toContain(legacyReference);

    await fs.writeFile(path.join(root, "tracked.txt"), "after checkpoint");
    const indexBeforeRestore = (await execute("git", ["-C", root, "diff", "--cached"])).stdout;
    const preRestore = await checkpoints.restore(reference!, "tracked.txt");
    expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe("modified");
    expect((await execute("git", ["-C", root, "diff", "--cached"])).stdout).toBe(indexBeforeRestore);
    expect(preRestore).toMatch(/^refs\/antler\/checkpoints\//);
    await fs.writeFile(path.join(root, "tracked.txt"), "after legacy checkpoint");
    await expect(checkpoints.restore(legacyReference, "tracked.txt")).resolves.toMatch(/^refs\/antler\/checkpoints\//);
    expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe("modified");
    await expect(checkpoints.restore(reference!, "../escape")).rejects.toThrow();
  });
});
