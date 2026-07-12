#!/usr/bin/env node

import { authenticateCodeServer } from "./auth/codeServerAuth.js";
import { parseConfig } from "./config.js";
import { PathConfinement } from "./confinement/pathConfinement.js";
import { Logger } from "./logging.js";
import { RemoteAgentManager } from "./remoteAgentManager.js";
import { SftpBridgeServer } from "./sftp/server.js";

async function main(): Promise<void> {
  const config = await parseConfig(process.argv);
  const logger = new Logger(config.logLevel);
  if (!config.rejectUnauthorized) {
    logger.warn("TLS certificate verification is disabled by explicit development option");
  }
  if (!config.profile.verified) {
    logger.warn("selected compatibility profile has not been verified against a live target", {
      profile: config.profile.name,
    });
  }
  logger.info("authenticating to code-server", { origin: config.codeServerUrl.origin, profile: config.profile.name });
  const session = await authenticateCodeServer({
    baseUrl: config.codeServerUrl,
    password: config.codeServerPassword,
    rejectUnauthorized: config.rejectUnauthorized,
  });
  const remoteVersion = await session.probeVersion();
  if (remoteVersion !== config.profile.productCommit && !config.allowVersionMismatch) {
    throw new Error(
      `code-server /version returned ${remoteVersion || "an empty commit"}; expected ${config.profile.productCommit}. ` +
        "Select the matching profile or use --allow-version-mismatch for protocol development.",
    );
  }
  logger.info("code-server session authenticated", { remoteVersion });

  const manager = new RemoteAgentManager({
    session,
    profile: config.profile,
    rejectUnauthorized: config.rejectUnauthorized,
    sendOrigin: config.sendOrigin,
  });
  const server = new SftpBridgeServer({
      bindAddress: config.bindAddress,
      port: config.port,
      hostKeyPath: config.hostKeyPath,
      username: config.sftpUsername,
      password: config.sftpPassword,
      remoteRoot: config.remoteRoot,
      stagingDirectory: config.stagingDirectory,
      manager,
      logger,
    });
  try {
    const initial = await manager.get();
    await new PathConfinement(config.remoteRoot, initial.client).verifyRoot();
    logger.info("remote filesystem channel initialized", { remoteRoot: config.remoteRoot });
    await server.start();
  } catch (error) {
    await manager.stop();
    throw error;
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("stopping SFTP bridge");
    await server.stop();
    await manager.stop();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
}

main().catch((error: unknown) => {
  const logger = new Logger("error");
  logger.error("bridge startup failed", { error });
  process.exitCode = 1;
});
