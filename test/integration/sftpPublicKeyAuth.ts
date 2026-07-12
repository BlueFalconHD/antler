import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { Logger } from "../../src/logging.js";
import type { RemoteAgentManager } from "../../src/remoteAgentManager.js";
import { resolveLocalSftpAuthentication } from "../../src/sftp/clientAuth.js";
import { SftpBridgeServer } from "../../src/sftp/server.js";

const { utils } = ssh2;

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
const server = new SftpBridgeServer({
  bindAddress: "127.0.0.1",
  port: 0,
  hostKeyPath: path.join(directory, "host-key"),
  username: "moose",
  authentication,
  remoteRoot: "/unused",
  stagingDirectory: path.join(directory, "stage"),
  manager: {} as RemoteAgentManager,
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
  process.stdout.write("SFTP public-key authentication smoke test passed\n");
} finally {
  client.end();
  await server.stop();
  await fs.rm(directory, { recursive: true, force: true });
}
