import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { Logger } from "../../src/logging.js";
import type { RemoteAgentManager } from "../../src/remoteAgentManager.js";
import { resolveLocalSftpAuthentication } from "../../src/sftp/clientAuth.js";
import { SftpBridgeServer } from "../../src/sftp/server.js";
import { FileType, type RemoteFileSystemClient } from "../../src/vscode/remoteFileSystem.js";

const { utils } = ssh2;

class FakeRemoteAgentManager extends EventEmitter {
  public readonly statCalls: string[] = [];
  public readCalls = 0;
  public readFileCalls = 0;
  private readonly data = Buffer.alloc(256 * 1024, 0x64);
  private readonly client = {
    stat: async (remotePath: string) => {
      this.statCalls.push(remotePath);
      return remotePath === "/unused/file.bin"
        ? { type: FileType.File, ctime: 1, mtime: 1, size: this.data.length }
        : { type: FileType.Directory, ctime: 1, mtime: 1, size: 0 };
    },
    readdir: async () => [{ name: "file.bin", type: FileType.File }],
    openRead: async () => 1,
    readFile: async () => {
      this.readFileCalls += 1;
      return this.data;
    },
    read: async (_fd: number, position: number, length: number) => {
      this.readCalls += 1;
      return this.data.subarray(position, position + length);
    },
    close: async () => undefined,
  } as unknown as RemoteFileSystemClient;

  public async get() {
    return { client: this.client, generation: 1 };
  }

  public assertGeneration(): void {}
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moose-proxy-sftp-auth-test-"));
const pair = utils.generateKeyPairSync("ed25519");
const publicKeyPath = path.join(directory, "client.pub");
await fs.writeFile(publicKeyPath, pair.public);
const resolved = await resolveLocalSftpAuthentication({
  password: undefined,
  authorizedKeyPaths: [publicKeyPath],
  stateFile: path.join(directory, "last-key"),
  agentPublicKeys: [],
});
let rememberedFingerprint: string | undefined;
const authentication = {
  ...resolved,
  rememberSuccessfulKey: async (fingerprint: string) => {
    rememberedFingerprint = fingerprint;
  },
};
const manager = new FakeRemoteAgentManager();
const server = new SftpBridgeServer({
  bindAddress: "127.0.0.1",
  port: 0,
  hostKeyPath: path.join(directory, "host-key"),
  username: "moose",
  authentication,
  remoteRoot: "/unused",
  stagingDirectory: path.join(directory, "stage"),
  manager: manager as unknown as RemoteAgentManager,
  logger: new Logger("error"),
});
const client = new ssh2.Client();
try {
  await server.start();
  const ready = once(client, "ready");
  client.connect({
    host: "127.0.0.1",
    port: server.listeningPort,
    username: "moose",
    privateKey: pair.private,
    hostVerifier: () => true,
    readyTimeout: 5_000,
  });
  await ready;
  if (rememberedFingerprint !== resolved.preferredKey?.fingerprint) {
    throw new Error("server did not authenticate and remember the expected public key");
  }
  const sftp = await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
    client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)));
  });
  const realPath = await new Promise<string>((resolve, reject) => {
    sftp.realpath("", (error, resolvedPath) => (error ? reject(error) : resolve(resolvedPath)));
  });
  if (realPath !== "/") {
    throw new Error(`empty REALPATH resolved to ${realPath} instead of /`);
  }
  manager.statCalls.length = 0;
  const entries = await new Promise<ssh2.FileEntry[]>((resolve, reject) => {
    sftp.readdir("/", (error, list) => (error ? reject(error) : resolve(list)));
  });
  if (entries.length !== 1 || manager.statCalls.join(",") !== "/unused,/unused/file.bin") {
    throw new Error(`optimized directory listing made unexpected stat calls: ${manager.statCalls.join(",")}`);
  }
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open("/file.bin", "r", (error, opened) => (error ? reject(error) : resolve(opened)));
  });
  await Promise.all(
    [0, 32 * 1024, 64 * 1024].map(
      (position) =>
        new Promise<void>((resolve, reject) => {
          const buffer = Buffer.alloc(32 * 1024);
          sftp.read(handle, buffer, 0, buffer.length, position, (error, count) => {
            if (error) {
              reject(error);
            } else if (count !== buffer.length) {
              reject(new Error(`unexpected read length ${count}`));
            } else {
              resolve();
            }
          });
        }),
    ),
  );
  if (manager.readFileCalls !== 1 || manager.readCalls !== 0) {
    throw new Error(
      `three small SFTP reads caused ${manager.readFileCalls} bulk reads and ${manager.readCalls} descriptor reads`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    sftp.close(handle, (error) => (error ? reject(error) : resolve()));
  });
  sftp.end();
  process.stdout.write("SFTP authentication, optimized listing, and bulk-read smoke test passed\n");
} finally {
  client.end();
  await server.stop();
  await fs.rm(directory, { recursive: true, force: true });
}
