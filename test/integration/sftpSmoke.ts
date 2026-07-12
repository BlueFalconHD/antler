import { promises as fs } from "node:fs";
import ssh2, { type OpenMode, type SFTPWrapper } from "ssh2";

const host = process.env.MOOSE_PROXY_INTEGRATION_HOST ?? "127.0.0.1";
const port = Number(process.env.MOOSE_PROXY_INTEGRATION_PORT ?? "39022");
const username = process.env.MOOSE_PROXY_INTEGRATION_USERNAME ?? "moose";
const passwordFile = process.env.MOOSE_PROXY_INTEGRATION_PASSWORD_FILE;
if (!passwordFile) {
  throw new Error("MOOSE_PROXY_INTEGRATION_PASSWORD_FILE is required");
}
const password = (await fs.readFile(passwordFile, "utf8")).replace(/\r?\n$/, "");

const client = new ssh2.Client();
const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
  client.once("ready", () => client.sftp((error, value) => (error ? reject(error) : resolve(value))));
  client.once("error", reject);
  client.connect({ host, port, username, password, hostVerifier: () => true });
});

function simple(operation: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => operation((error) => (error ? reject(error) : resolve())));
}

function open(remotePath: string, flags: OpenMode): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    sftp.open(remotePath, flags, (error, handle) => (error ? reject(error) : resolve(handle))),
  );
}

async function readAll(remotePath: string): Promise<Buffer> {
  const handle = await open(remotePath, "r");
  const chunks: Buffer[] = [];
  try {
    let position = 0;
    while (true) {
      const chunk = Buffer.alloc(4);
      const bytesRead = await new Promise<number>((resolve, reject) =>
        sftp.read(handle, chunk, 0, chunk.length, position, (error, count) =>
          error ? ((error as Error & { code?: number }).code === 1 ? resolve(0) : reject(error)) : resolve(count),
        ),
      );
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await simple((callback) => sftp.close(handle, callback));
  }
  return Buffer.concat(chunks);
}

const directory = `/integration-${process.pid}`;
const file = `${directory}/offset.txt`;
const renamed = `${directory}/renamed.txt`;
try {
  await simple((callback) => sftp.mkdir(directory, callback));
  const initial = await open(file, "w");
  await simple((callback) => sftp.write(initial, Buffer.from("abcdef"), 0, 6, 0, callback));
  await simple((callback) => sftp.close(initial, callback));

  const unchanged = await open(file, "r+");
  await simple((callback) => sftp.close(unchanged, callback));
  if ((await readAll(file)).toString() !== "abcdef") {
    throw new Error("unchanged write handle altered the file");
  }

  const update = await open(file, "r+");
  await simple((callback) => sftp.write(update, Buffer.from("ZZ"), 0, 2, 2, callback));
  const stagedRead = Buffer.alloc(6);
  const stagedCount = await new Promise<number>((resolve, reject) =>
    sftp.read(update, stagedRead, 0, stagedRead.length, 0, (error, count) =>
      error ? reject(error) : resolve(count),
    ),
  );
  if (stagedRead.subarray(0, stagedCount).toString() !== "abZZef") {
    throw new Error("read-after-offset-write returned unexpected data");
  }
  await simple((callback) => sftp.close(update, callback));
  if ((await readAll(file)).toString() !== "abZZef") {
    throw new Error("offset write did not persist");
  }

  const truncate = await open(file, "r+");
  await simple((callback) => sftp.fsetstat(truncate, { size: 3 }, callback));
  await simple((callback) => sftp.close(truncate, callback));
  if ((await readAll(file)).toString() !== "abZ") {
    throw new Error("truncate did not persist");
  }

  await simple((callback) => sftp.rename(file, renamed, callback));
  await simple((callback) => sftp.unlink(renamed, callback));
  await simple((callback) => sftp.rmdir(directory, callback));
  process.stdout.write("SFTP offset-write/truncate smoke test passed\n");
} finally {
  client.end();
}
