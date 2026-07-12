import ssh2 from "ssh2";
import { RemoteRpcError } from "../vscode/ipcClient.js";

export const SFTP_STATUS = ssh2.utils.sftp.STATUS_CODE;

export class SftpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SftpError";
  }
}

export function toSftpError(error: unknown): SftpError {
  if (error instanceof SftpError) {
    return error;
  }
  if (error instanceof RemoteRpcError) {
    if (error.name.startsWith("EntryNotFound")) {
      return new SftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file or directory");
    }
    if (error.name.startsWith("NoPermissions") || error.name.startsWith("EntryWriteLocked")) {
      return new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Permission denied");
    }
    if (error.name.startsWith("Unavailable")) {
      return new SftpError(SFTP_STATUS.NO_CONNECTION, "Remote filesystem unavailable");
    }
    if (error.name.startsWith("EntryExists")) {
      return new SftpError(SFTP_STATUS.FAILURE, "File already exists");
    }
    if (error.name.startsWith("EntryNotADirectory")) {
      return new SftpError(SFTP_STATUS.FAILURE, "Not a directory");
    }
    if (error.name.startsWith("EntryIsADirectory")) {
      return new SftpError(SFTP_STATUS.FAILURE, "Is a directory");
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/closed|disconnect|connection|socket/i.test(message)) {
    return new SftpError(SFTP_STATUS.CONNECTION_LOST, "Remote connection lost");
  }
  return new SftpError(SFTP_STATUS.FAILURE, "Remote filesystem operation failed");
}

export function isNotFound(error: unknown): boolean {
  return error instanceof RemoteRpcError && error.name.startsWith("EntryNotFound");
}
