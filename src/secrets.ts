import { promises as fs } from "node:fs";
import path from "node:path";

export async function loadCodeServerPassword(filePath?: string): Promise<string> {
  const environmentValue = process.env.ANTLER_CODE_SERVER_PASSWORD;
  if (filePath && environmentValue) {
    throw new Error("Use either a password file or ANTLER_CODE_SERVER_PASSWORD, not both");
  }
  const value = filePath
    ? await readProtectedFile(path.resolve(filePath), "Code-server password")
    : environmentValue ?? await promptSecret("Code-server password");
  if (!value) {
    throw new Error("Code-server password must not be empty");
  }
  return value;
}

export async function promptText(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} is required in non-interactive mode`);
  }
  process.stderr.write(`${label}: `);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString("utf8").replace(/\r?\n$/, "").trim());
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.pause();
    };
    process.stdin.once("data", onData);
    process.stdin.once("error", onError);
  });
}

async function readProtectedFile(filePath: string, label: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} file must be a regular non-symlink file`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} file permissions must be 0600 or stricter`);
  }
  return (await fs.readFile(filePath, "utf8")).replace(/\r?\n$/, "");
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error(
      `${label} is required. Set ANTLER_CODE_SERVER_PASSWORD or configure a protected password file.`,
    );
  }
  process.stderr.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Password prompt cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}
