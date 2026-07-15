import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { ReconcileResult } from "./sync/types.js";

const CONTROL_FILE_NAME = "live-control.json";
const CONTROL_DIRECTORY_NAME = "live-control";
const REQUEST_SUFFIX = ".request.json";
const PROCESSING_SUFFIX = ".processing.json";
const RESPONSE_SUFFIX = ".response.json";
const POLL_MILLISECONDS = 50;

interface ControlMetadata {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

interface AuthenticatedRequest {
  readonly token: string;
  readonly request: LiveSyncRequest;
}

export interface LiveSyncRequest {
  readonly type: "reconcile";
  readonly approveDeletes: boolean;
  readonly forceLargeDelete: boolean;
}

export interface LiveSyncResult {
  readonly conflicts: number;
  readonly pendingDeletes: number;
  readonly transferredBytes: number;
}

interface ControlResponse {
  readonly ok: boolean;
  readonly result?: LiveSyncResult;
  readonly error?: string;
}

export interface LiveSyncControl {
  close(): Promise<void>;
}

export async function startLiveSyncControl(
  stateDirectory: string,
  reconcile: (request: LiveSyncRequest) => Promise<ReconcileResult>,
): Promise<LiveSyncControl> {
  const token = randomBytes(32).toString("hex");
  const directory = path.join(stateDirectory, CONTROL_DIRECTORY_NAME);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { mode: 0o700 });

  let closed = false;
  let watcher: FSWatcher | undefined;
  let interval: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  const schedule = () => {
    if (closed || draining) return;
    draining = drainRequests(directory, token, reconcile)
      .catch(() => undefined)
      .finally(() => {
        draining = undefined;
      });
  };

  try {
    watcher = watch(directory, schedule);
    watcher.on("error", () => undefined);
    interval = setInterval(schedule, POLL_MILLISECONDS);
    await writeAtomic(stateDirectory, CONTROL_FILE_NAME, {
      schemaVersion: 1,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    } satisfies ControlMetadata);
    schedule();

    return {
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        watcher?.close();
        await removeOwnedMetadata(stateDirectory, token);
        await draining;
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closed = true;
    if (interval) clearInterval(interval);
    watcher?.close();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function requestLiveSync(
  stateDirectory: string,
  request: Omit<LiveSyncRequest, "type">,
): Promise<LiveSyncResult | undefined> {
  const metadata = await readMetadata(stateDirectory);
  if (!metadata || !processIsAlive(metadata.pid)) return undefined;
  const directory = path.join(stateDirectory, CONTROL_DIRECTORY_NAME);
  const id = randomUUID();
  try {
    await writeAtomic(directory, `${id}${REQUEST_SUFFIX}`, {
      token: metadata.token,
      request: { type: "reconcile", ...request },
    } satisfies AuthenticatedRequest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    return await waitForResponse(stateDirectory, directory, id, metadata);
  } finally {
    await Promise.all([
      fs.rm(path.join(directory, `${id}${REQUEST_SUFFIX}`), { force: true }),
      fs.rm(path.join(directory, `${id}${PROCESSING_SUFFIX}`), { force: true }),
      fs.rm(path.join(directory, `${id}${RESPONSE_SUFFIX}`), { force: true }),
    ]);
  }
}

async function drainRequests(
  directory: string,
  token: string,
  reconcile: (request: LiveSyncRequest) => Promise<ReconcileResult>,
): Promise<void> {
  while (true) {
    const requests = (await fs.readdir(directory))
      .filter((entry) => entry.endsWith(REQUEST_SUFFIX))
      .sort();
    if (requests.length === 0) return;
    for (const requestFile of requests) {
      await processRequest(directory, requestFile, token, reconcile);
    }
  }
}

async function processRequest(
  directory: string,
  requestFile: string,
  token: string,
  reconcile: (request: LiveSyncRequest) => Promise<ReconcileResult>,
): Promise<void> {
  const id = requestFile.slice(0, -REQUEST_SUFFIX.length);
  const requestPath = path.join(directory, requestFile);
  const processingPath = path.join(directory, `${id}${PROCESSING_SUFFIX}`);
  try {
    await fs.rename(requestPath, processingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  let response: ControlResponse;
  try {
    const value: unknown = JSON.parse(await fs.readFile(processingPath, "utf8"));
    if (!isAuthenticatedRequest(value, token)) {
      throw new Error("Invalid live synchronization control request");
    }
    const result = await reconcile(value.request);
    response = {
      ok: true,
      result: {
        conflicts: result.conflicts,
        pendingDeletes: result.pendingDeletes,
        transferredBytes: result.transferredBytes,
      },
    };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  await writeAtomic(directory, `${id}${RESPONSE_SUFFIX}`, response);
  await fs.rm(processingPath, { force: true });
}

async function waitForResponse(
  stateDirectory: string,
  directory: string,
  id: string,
  owner: ControlMetadata,
): Promise<LiveSyncResult> {
  const responsePath = path.join(directory, `${id}${RESPONSE_SUFFIX}`);
  let attempts = 0;
  while (true) {
    try {
      const value: unknown = JSON.parse(await fs.readFile(responsePath, "utf8"));
      if (!isControlResponse(value)) {
        throw new Error("Live synchronization control response is invalid");
      }
      if (!value.ok) throw new Error(value.error ?? "Live synchronization request failed");
      if (!value.result) throw new Error("Live synchronization control response omitted its result");
      return value.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    attempts += 1;
    if (attempts % 20 === 0) {
      const current = await readMetadata(stateDirectory);
      if (!current || current.token !== owner.token || !processIsAlive(owner.pid)) {
        throw new Error("Live synchronization stopped before the request completed");
      }
    }
    await delay(POLL_MILLISECONDS);
  }
}

function isAuthenticatedRequest(value: unknown, expectedToken: string): value is AuthenticatedRequest {
  if (!isObject(value) || typeof value.token !== "string" || !tokensMatch(value.token, expectedToken)) {
    return false;
  }
  const request = value.request;
  return (
    isObject(request) &&
    request.type === "reconcile" &&
    typeof request.approveDeletes === "boolean" &&
    typeof request.forceLargeDelete === "boolean"
  );
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isControlResponse(value: unknown): value is ControlResponse {
  if (!isObject(value) || typeof value.ok !== "boolean") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.result === undefined) return true;
  return (
    isObject(value.result) &&
    typeof value.result.conflicts === "number" &&
    typeof value.result.pendingDeletes === "number" &&
    typeof value.result.transferredBytes === "number"
  );
}

async function writeAtomic(directory: string, fileName: string, value: unknown): Promise<void> {
  const temporary = path.join(directory, `.${fileName}-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await fs.rename(temporary, path.join(directory, fileName));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function readMetadata(stateDirectory: string): Promise<ControlMetadata | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(path.join(stateDirectory, CONTROL_FILE_NAME), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Unable to read the live synchronization control channel: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isControlMetadata(value)) throw new Error("Live synchronization control metadata is malformed");
  return value;
}

function isControlMetadata(value: unknown): value is ControlMetadata {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    typeof value.token === "string" &&
    value.token.length >= 32 &&
    typeof value.startedAt === "string"
  );
}

async function removeOwnedMetadata(stateDirectory: string, token: string): Promise<void> {
  try {
    const metadata = await readMetadata(stateDirectory);
    if (metadata?.token === token) {
      await fs.rm(path.join(stateDirectory, CONTROL_FILE_NAME), { force: true });
    }
  } catch {
    // A replacement or damaged file must not be removed by an older controller.
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
