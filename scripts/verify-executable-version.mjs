import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { URL } from "node:url";

const executable = process.argv[2];
if (!executable) throw new Error("An Antler executable path is required");

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (!packageJson || typeof packageJson.version !== "string") {
  throw new Error("package.json does not contain a valid version");
}

const { stdout } = await promisify(execFile)(executable, ["--version"]);
const actual = stdout.trim();
if (actual !== packageJson.version) {
  throw new Error(`Antler executable reports ${actual || "(empty)"}, expected ${packageJson.version}`);
}

process.stdout.write(`Antler executable reports ${actual}\n`);
