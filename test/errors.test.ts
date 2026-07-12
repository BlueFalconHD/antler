import { describe, expect, it } from "vitest";
import { SFTP_STATUS, toSftpError } from "../src/sftp/errors.js";
import { RemoteRpcError } from "../src/vscode/ipcClient.js";

describe("SFTP error translation", () => {
  it.each([
    ["EntryNotFound (FileSystemError)", SFTP_STATUS.NO_SUCH_FILE],
    ["NoPermissions (FileSystemError)", SFTP_STATUS.PERMISSION_DENIED],
    ["EntryWriteLocked (FileSystemError)", SFTP_STATUS.PERMISSION_DENIED],
    ["Unavailable (FileSystemError)", SFTP_STATUS.NO_CONNECTION],
  ])("maps %s", (name, expected) => {
    expect(toSftpError(new RemoteRpcError("remote failure", name)).status).toBe(expected);
  });

  it("never reports unknown errors as success", () => {
    expect(toSftpError(new Error("boom")).status).toBe(SFTP_STATUS.FAILURE);
  });
});
