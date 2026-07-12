import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

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
    const decoder = new StringDecoder("utf8");
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const update = applyMaskedSecretInput(value, decoder.write(chunk));
      value = update.value;
      process.stderr.write(update.maskedOutput);
      if (update.cancelled) {
        cleanup();
        reject(new Error("Password prompt cancelled"));
      } else if (update.complete) {
        cleanup();
        resolve(value);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    process.stdin.on("data", onData);
    process.stdin.once("error", onError);
  });
}

export function applyMaskedSecretInput(
  currentValue: string,
  input: string,
): { readonly value: string; readonly maskedOutput: string; readonly complete: boolean; readonly cancelled: boolean } {
  let value = currentValue;
  let maskedOutput = "";
  for (const character of input) {
    if (character === "\u0003" || character === "\u0004") {
      return { value, maskedOutput, complete: false, cancelled: true };
    }
    if (character === "\r" || character === "\n") {
      return { value, maskedOutput, complete: true, cancelled: false };
    }
    if (character === "\u007f" || character === "\b") {
      const characters = [...value];
      if (characters.length > 0) {
        characters.pop();
        value = characters.join("");
        maskedOutput += "\b \b";
      }
      continue;
    }
    if (character === "\u0015") {
      maskedOutput += "\b \b".repeat([...value].length);
      value = "";
      continue;
    }
    if (character >= " ") {
      value += character;
      maskedOutput += "*";
    }
  }
  return { value, maskedOutput, complete: false, cancelled: false };
}
