import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { authenticateCodeServer } from "../../src/auth/codeServerAuth.js";
import { compatibilityProfiles } from "../../src/compatibility/profiles.js";
import { connectRemoteAgent } from "../../src/vscode/handshake.js";
import { vsBuffer } from "../../src/vscode/serialization.js";

const baseUrlValue = process.env.MOOSE_PROXY_INTEGRATION_CODE_SERVER_URL;
const passwordFile = process.env.MOOSE_PROXY_INTEGRATION_CODE_SERVER_PASSWORD_FILE;
const remoteRoot = process.env.MOOSE_PROXY_INTEGRATION_REMOTE_ROOT;
if (!baseUrlValue || !passwordFile || !remoteRoot) {
  throw new Error(
    "MOOSE_PROXY_INTEGRATION_CODE_SERVER_URL, MOOSE_PROXY_INTEGRATION_CODE_SERVER_PASSWORD_FILE, and " +
      "MOOSE_PROXY_INTEGRATION_REMOTE_ROOT are required",
  );
}

const password = (await fs.readFile(passwordFile, "utf8")).replace(/\r?\n$/, "");
const session = await authenticateCodeServer({ baseUrl: new URL(baseUrlValue), password, rejectUnauthorized: true });
const connection = await connectRemoteAgent({
  session,
  profile: compatibilityProfiles["custom-v69"],
  rejectUnauthorized: true,
  sendOrigin: true,
});

const uri = (remotePath: string) => ({
  $mid: 1,
  scheme: "vscode-remote",
  authority: connection.remoteAuthority,
  path: remotePath,
});
const call = (command: string, args: unknown[]) => connection.ipc.call("remoteFilesystem", command, args);

async function close(descriptor: number): Promise<void> {
  await call("close", [descriptor]);
}

async function writeAll(descriptor: number, position: number, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = (await call("write", [
      descriptor,
      position + offset,
      vsBuffer(data),
      offset,
      data.length - offset,
    ])) as number;
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("write probe made no progress");
    }
    offset += written;
  }
}

async function readAll(remotePath: string): Promise<Buffer> {
  const descriptor = (await call("open", [uri(remotePath), { create: false }])) as number;
  const chunks: Buffer[] = [];
  try {
    let position = 0;
    while (true) {
      const [buffer, count] = (await call("read", [descriptor, position, 1024])) as [Buffer, number];
      if (count === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, count));
      position += count;
    }
  } finally {
    await close(descriptor);
  }
  return Buffer.concat(chunks);
}

const candidates: Array<{ name: string; options: Record<string, unknown> }> = [
  { name: "create=false,write=true", options: { create: false, write: true } },
  { name: "create=false,writable=true", options: { create: false, writable: true } },
  { name: "create=false,write=true,truncate=false", options: { create: false, write: true, truncate: false } },
  { name: "create=true,write=true,truncate=false", options: { create: true, write: true, truncate: false } },
  { name: "create=true,truncate=false", options: { create: true, truncate: false } },
];

const results: Array<Record<string, unknown>> = [];
try {
  for (const candidate of candidates) {
    const remotePath = path.posix.join(remoteRoot, `.moose-proxy-write-probe-${randomUUID()}`);
    try {
      const initial = (await call("open", [uri(remotePath), { create: true, unlock: false }])) as number;
      await writeAll(initial, 0, Buffer.from("0123456789"));
      await close(initial);

      const descriptor = (await call("open", [uri(remotePath), candidate.options])) as number;
      let writeError: string | undefined;
      try {
        const statAfterOpen = (await call("stat", [uri(remotePath)])) as { size: number };
        if (statAfterOpen.size !== 10) {
          results.push({ name: candidate.name, supported: false, reason: `open truncated file to ${statAfterOpen.size}` });
          continue;
        }
        try {
          await writeAll(descriptor, 4, Buffer.from("XYZ"));
        } catch (error) {
          writeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
      } finally {
        await close(descriptor);
      }
      const content = await readAll(remotePath);
      results.push({
        name: candidate.name,
        supported: content.toString() === "0123XYZ789",
        result: content.toString(),
        ...(writeError ? { writeError } : {}),
      });
    } finally {
      try {
        await call("delete", [uri(remotePath), { recursive: false, useTrash: false, atomic: false }]);
      } catch {
        // Best-effort cleanup for a disposable probe file.
      }
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await connection.close();
  await session.close();
}
