import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authenticateCodeServer } from "../../src/auth/codeServerAuth.js";
import { compatibilityProfiles, type CompatibilityProfileName } from "../../src/compatibility/profiles.js";
import { GitCheckpoints } from "../../src/git/checkpoints.js";
import { RemoteAgentManager } from "../../src/remoteAgentManager.js";
import { LocalTree } from "../../src/sync/localTree.js";
import { ObjectStore } from "../../src/sync/objectStore.js";
import { RemoteTree } from "../../src/sync/remoteTree.js";
import { StateStore } from "../../src/sync/stateStore.js";
import { SyncEngine } from "../../src/sync/syncEngine.js";

const url = process.env.MOOSE_PROXY_INTEGRATION_CODE_SERVER_URL;
const passwordFile = process.env.MOOSE_PROXY_INTEGRATION_CODE_SERVER_PASSWORD_FILE;
const baseRemoteRoot = process.env.MOOSE_PROXY_INTEGRATION_REMOTE_ROOT;
const profileName = (process.env.MOOSE_PROXY_INTEGRATION_PROFILE ?? "custom-v69") as CompatibilityProfileName;
if (!url || !passwordFile || !baseRemoteRoot || !(profileName in compatibilityProfiles)) {
  throw new Error(
    "MOOSE_PROXY_INTEGRATION_CODE_SERVER_URL, MOOSE_PROXY_INTEGRATION_CODE_SERVER_PASSWORD_FILE, " +
    "MOOSE_PROXY_INTEGRATION_REMOTE_ROOT, and a valid MOOSE_PROXY_INTEGRATION_PROFILE are required",
  );
}

const password = (await fs.readFile(passwordFile, "utf8")).replace(/\r?\n$/, "");
const session = await authenticateCodeServer({ baseUrl: new URL(url), password, rejectUnauthorized: true });
const manager = new RemoteAgentManager({
  session,
  profile: compatibilityProfiles[profileName],
  rejectUnauthorized: true,
  sendOrigin: true,
});
const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "moose-sync-smoke-"));
const remoteRoot = path.posix.join(baseRemoteRoot, `.moose-proxy-sync-smoke-${randomUUID()}`);

try {
  const { client } = await manager.get();
  await client.mkdir(remoteRoot);
  const local = new LocalTree({ root: localRoot });
  const remote = new RemoteTree({ manager, root: remoteRoot, concurrency: 4 });
  await Promise.all([local.initialize(), remote.initialize()]);
  const stateDirectory = path.join(localRoot, ".moose_proxy");
  const state = new StateStore(stateDirectory);
  await state.initialize("integration");
  const git = new GitCheckpoints(localRoot, stateDirectory, false);
  await git.initialize();
  const engine = new SyncEngine({
    local,
    remote,
    state,
    objects: new ObjectStore(stateDirectory),
    git,
    concurrency: 4,
    maxDeletes: 100,
    maxDeletePercent: 100,
  });

  await fs.writeFile(path.join(localRoot, "roundtrip.txt"), "local-v1");
  await engine.reconcile();
  if ((await client.readFile(path.posix.join(remoteRoot, "roundtrip.txt"))).toString() !== "local-v1") {
    throw new Error("initial upload failed");
  }

  let watcherResolve: ((paths: readonly string[]) => void) | undefined;
  const watcherEvent = new Promise<readonly string[]>((resolve) => { watcherResolve = resolve; });
  const watcher = await client.watch(
    remoteRoot,
    (changes) => watcherResolve?.(changes.map((change) => change.path)),
    (error) => { throw error; },
  );
  await client.writeFile(path.posix.join(remoteRoot, "roundtrip.txt"), Buffer.from("remote-v2"), true);
  const changedPaths = await Promise.race([
    watcherEvent,
    new Promise<readonly string[]>((_, reject) => setTimeout(() => reject(new Error("remote watcher timed out")), 10_000)),
  ]);
  if (!changedPaths.some((entry) => entry.endsWith("/roundtrip.txt"))) {
    throw new Error("watcher did not report the changed file");
  }
  await watcher.dispose();
  await engine.reconcile({ paths: ["roundtrip.txt"] });
  if ((await fs.readFile(path.join(localRoot, "roundtrip.txt"), "utf8")) !== "remote-v2") {
    throw new Error("remote-to-local update failed");
  }

  await fs.writeFile(path.join(localRoot, "roundtrip.txt"), "local-conflict");
  await client.writeFile(path.posix.join(remoteRoot, "roundtrip.txt"), Buffer.from("remote-conflict"), true);
  const conflict = await engine.reconcile({ paths: ["roundtrip.txt"] });
  if (conflict.conflicts !== 1) throw new Error("simultaneous changes were not preserved as a conflict");

  await engine.resolve("roundtrip.txt", "local");
  if ((await client.readFile(path.posix.join(remoteRoot, "roundtrip.txt"))).toString() !== "local-conflict") {
    throw new Error("conflict resolution failed");
  }

  await fs.mkdir(path.join(localRoot, "nested"));
  await fs.writeFile(path.join(localRoot, "nested", "upload.txt"), "nested");
  await engine.reconcile();
  if ((await client.readFile(path.posix.join(remoteRoot, "nested/upload.txt"))).toString() !== "nested") {
    throw new Error("nested upload failed");
  }

  await fs.unlink(path.join(localRoot, "nested", "upload.txt"));
  const pending = await engine.reconcile();
  if (pending.pendingDeletes === 0) throw new Error("delete was not held for approval");
  await engine.reconcile({ approveDeletes: true, forceLargeDelete: true });
  try {
    await client.stat(path.posix.join(remoteRoot, "nested/upload.txt"));
    throw new Error("approved remote deletion did not occur");
  } catch (error) {
    if (error instanceof Error && error.message === "approved remote deletion did not occur") throw error;
  }

  process.stdout.write("Bidirectional sync smoke test passed\n");
} finally {
  try {
    const { client } = await manager.get();
    await client.delete(remoteRoot, true);
  } catch {
    // Disposable integration root cleanup is best-effort after connection failure.
  }
  await manager.stop();
  await session.close();
  await fs.rm(localRoot, { recursive: true, force: true });
}
