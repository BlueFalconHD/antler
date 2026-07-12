import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command, Option } from "commander";
import {
  compatibilityProfiles,
  type CompatibilityProfile,
  type CompatibilityProfileName,
} from "./compatibility/profiles.js";
import type { LogLevel } from "./logging.js";
import { validateRemoteRoot } from "./confinement/pathConfinement.js";
import {
  resolveLocalSftpAuthentication,
  type LocalSftpAuthentication,
} from "./sftp/clientAuth.js";

export interface BridgeConfig {
  readonly codeServerUrl: URL;
  readonly codeServerPassword: string;
  readonly remoteRoot: string;
  readonly profile: CompatibilityProfile;
  readonly bindAddress: string;
  readonly port: number;
  readonly allowNonLoopback: boolean;
  readonly hostKeyPath: string;
  readonly sftpUsername: string;
  readonly sftpAuthentication: LocalSftpAuthentication;
  readonly stagingDirectory: string;
  readonly rejectUnauthorized: boolean;
  readonly sendOrigin: boolean;
  readonly allowVersionMismatch: boolean;
  readonly logLevel: LogLevel;
}

interface CliOptions {
  codeServerUrl: string;
  codeServerPasswordFile?: string;
  remoteRoot: string;
  profile: CompatibilityProfileName;
  bindAddress: string;
  port: string;
  allowNonLoopback?: boolean;
  sshHostKey: string;
  sftpUsername: string;
  sftpPasswordFile?: string;
  sftpAuthorizedKey: string[];
  stagingDirectory: string;
  insecureSkipTlsVerify?: boolean;
  omitOrigin?: boolean;
  allowVersionMismatch?: boolean;
  logLevel: LogLevel;
}

function defaultConfigDirectory(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function normalizeCodeServerUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("code-server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("code-server URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("code-server URL must not contain a query string or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function isLoopback(address: string): boolean {
  if (address.toLowerCase() === "localhost") {
    return true;
  }
  const family = net.isIP(address);
  if (family === 4) {
    return address.startsWith("127.");
  }
  return family === 6 && (address === "::1" || address.toLowerCase() === "0:0:0:0:0:0:0:1");
}

async function readProtectedFile(filePath: string, label: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} file must be a regular non-symlink file`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} file permissions must not allow group or other access`);
  }
  const value = await fs.readFile(filePath, "utf8");
  return value.replace(/\r?\n$/, "");
}

async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error(`${prompt} is required via its environment variable or protected file option`);
  }
  process.stderr.write(`${prompt}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("secret prompt cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
        } else {
          value += String.fromCharCode(byte);
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function loadSecret(filePath: string | undefined, environmentName: string, label: string): Promise<string> {
  const environmentValue = process.env[environmentName];
  if (filePath && environmentValue) {
    throw new Error(`set only one of --${label.toLowerCase().replaceAll(" ", "-")}-file or ${environmentName}`);
  }
  const value = filePath
    ? await readProtectedFile(path.resolve(filePath), label)
    : environmentValue ?? (await promptSecret(label));
  if (!value) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

async function loadOptionalSecret(
  filePath: string | undefined,
  environmentName: string,
  label: string,
): Promise<string | undefined> {
  const environmentValue = process.env[environmentName];
  if (filePath && environmentValue) {
    throw new Error(`set only one of --${label.toLowerCase().replaceAll(" ", "-")}-file or ${environmentName}`);
  }
  if (!filePath && environmentValue === undefined) {
    return undefined;
  }
  const value = filePath ? await readProtectedFile(path.resolve(filePath), label) : environmentValue;
  if (!value) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

export async function parseConfig(argv: readonly string[]): Promise<BridgeConfig> {
  const program = new Command()
    .name("moose-proxy")
    .description("Expose a code-server remote filesystem through a local SFTP server")
    .requiredOption("--code-server-url <url>", "public code-server base URL, including any path prefix")
    .option("--code-server-password-file <path>", "0600 file containing the code-server password")
    .requiredOption("--remote-root <path>", "absolute remote POSIX directory to expose as SFTP /")
    .addOption(
      new Option("--profile <name>", "compatibility profile")
        .choices(Object.keys(compatibilityProfiles))
        .default("public-v4.20.1"),
    )
    .option("--bind-address <address>", "local SFTP listen address", "127.0.0.1")
    .option("--port <number>", "local SFTP port", "2222")
    .option("--allow-non-loopback", "explicitly allow a non-loopback listen address")
    .option(
      "--ssh-host-key <path>",
      "persistent SSH host private key (generated if absent)",
      path.join(defaultConfigDirectory(), "moose-proxy", "ssh_host_ed25519_key"),
    )
    .option("--sftp-username <name>", "local SFTP username", "moose")
    .option("--sftp-password-file <path>", "0600 file containing the local SFTP password")
    .option(
      "--sftp-authorized-key <path>",
      "SSH public key authorized for local SFTP (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--staging-directory <path>",
      "0700 local staging directory used for offset writes",
      path.join(os.tmpdir(), `moose-proxy-${process.getuid?.() ?? "user"}`),
    )
    .option("--insecure-skip-tls-verify", "DEVELOPMENT ONLY: disable code-server TLS certificate verification")
    .option("--omit-origin", "omit the browser-equivalent Origin header from the WebSocket upgrade")
    .option("--allow-version-mismatch", "continue when /version differs from the selected profile")
    .addOption(new Option("--log-level <level>").choices(["debug", "info", "warn", "error"]).default("info"));
  program.parse(argv as string[]);
  const options = program.opts<CliOptions>();
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer from 1 through 65535");
  }
  if (!isLoopback(options.bindAddress) && !options.allowNonLoopback) {
    throw new Error("binding to a non-loopback address requires --allow-non-loopback");
  }
  const profile = compatibilityProfiles[options.profile];
  const sftpPassword = await loadOptionalSecret(
    options.sftpPasswordFile,
    "MOOSE_PROXY_SFTP_PASSWORD",
    "SFTP password",
  );
  const sftpAuthentication = await resolveLocalSftpAuthentication({
    password: sftpPassword,
    authorizedKeyPaths: options.sftpAuthorizedKey,
    stateFile: path.join(defaultConfigDirectory(), "moose-proxy", "last_sftp_client_key"),
  });
  return {
    codeServerUrl: normalizeCodeServerUrl(options.codeServerUrl),
    codeServerPassword: await loadSecret(
      options.codeServerPasswordFile,
      "MOOSE_PROXY_CODE_SERVER_PASSWORD",
      "Code-server password",
    ),
    remoteRoot: validateRemoteRoot(options.remoteRoot),
    profile,
    bindAddress: options.bindAddress,
    port,
    allowNonLoopback: options.allowNonLoopback ?? false,
    hostKeyPath: path.resolve(options.sshHostKey),
    sftpUsername: options.sftpUsername,
    sftpAuthentication,
    stagingDirectory: path.resolve(options.stagingDirectory),
    rejectUnauthorized: !options.insecureSkipTlsVerify,
    sendOrigin: !options.omitOrigin,
    allowVersionMismatch: options.allowVersionMismatch ?? false,
    logLevel: options.logLevel,
  };
}
