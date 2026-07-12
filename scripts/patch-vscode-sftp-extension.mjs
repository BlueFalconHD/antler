#!/usr/bin/env node

import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const legacyImport = "const { inherits, isDate } = require('util');";
const compatibleImport = "const { inherits, types: { isDate } } = require('util');";

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

async function findInstalledExtension() {
  const extensionsDirectory = path.join(os.homedir(), ".vscode", "extensions");
  const entries = await fs.readdir(extensionsDirectory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("natizyskunk.sftp-"))
    .map((entry) => ({
      path: path.join(extensionsDirectory, entry.name),
      version: entry.name.slice("natizyskunk.sftp-".length),
    }))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (!candidates[0]) {
    throw new Error("Natizyskunk SFTP is not installed under ~/.vscode/extensions");
  }
  return candidates[0].path;
}

const argument = process.argv[2];
const extensionPath = argument ? path.resolve(argument) : await findInstalledExtension();
const target = extensionPath.endsWith("SFTP.js")
  ? extensionPath
  : path.join(extensionPath, "node_modules", "ssh2", "lib", "protocol", "SFTP.js");
const original = await fs.readFile(target, "utf8");
if (original.includes(compatibleImport)) {
  process.stdout.write(`Already compatible: ${target}\n`);
  process.exit(0);
}
if (!original.includes(legacyImport)) {
  throw new Error(`Expected ssh2 1.13 util.isDate import was not found in ${target}`);
}

const backup = `${target}.moose-proxy.bak`;
try {
  await fs.copyFile(target, backup, constants.COPYFILE_EXCL);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
    throw error;
  }
}

const stat = await fs.stat(target);
const temporary = `${target}.moose-proxy.tmp`;
try {
  await fs.writeFile(temporary, original.replace(legacyImport, compatibleImport), { mode: stat.mode });
  await fs.rename(temporary, target);
} finally {
  await fs.rm(temporary, { force: true });
}
process.stdout.write(`Patched ${target}\nBackup: ${backup}\nRestart VS Code before retrying the transfer.\n`);
