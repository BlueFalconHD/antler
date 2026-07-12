#!/usr/bin/env node

import { runCli } from "./cli.js";
import { Logger } from "./logging.js";

runCli(process.argv).catch((error: unknown) => {
  const logger = new Logger("error");
  logger.error("Command failed", { error });
  process.exitCode = error instanceof Error && /conflict/i.test(error.message) ? 2 : 1;
});
