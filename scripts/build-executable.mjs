import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const supportedTargets = new Set(["bun-linux-x64", "bun-windows-x64"]);
const target = process.argv[2];
if (target && !supportedTargets.has(target)) {
  throw new Error(`Unsupported executable target: ${target}`);
}

const windows = target?.startsWith("bun-windows-") || (!target && process.platform === "win32");
const output = path.join("dist", windows ? "antler.exe" : "antler");
await mkdir(path.dirname(output), { recursive: true });

const arguments_ = [
  "build",
  "src/index.ts",
  "--compile",
  "--minify",
  "--sourcemap",
  "--bytecode",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  `--outfile=${output}`,
];
if (target) arguments_.push(`--target=${target}`);

const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, arguments_, { stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (status) => resolve(status ?? 1));
});
if (code !== 0) process.exitCode = code;
