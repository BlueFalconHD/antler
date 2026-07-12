import { RemoteRpcError } from "./ipcClient.js";

export function isRemoteNotFound(error: unknown): boolean {
  return error instanceof RemoteRpcError && error.name.startsWith("EntryNotFound");
}

export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /closed|disconnect|connection|socket|ECONNRESET|EPIPE/i.test(message);
}
