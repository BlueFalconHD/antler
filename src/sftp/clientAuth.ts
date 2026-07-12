import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ssh2, { type ParsedKey } from "ssh2";

const { utils } = ssh2;

const execFileAsync = promisify(execFile);

export interface AuthorizedClientKey {
  readonly key: ParsedKey;
  readonly fingerprint: string;
  readonly source: string;
  readonly privateKeyHint?: string;
}

export interface LocalSftpAuthentication {
  readonly password: string | undefined;
  readonly authorizedKeys: readonly AuthorizedClientKey[];
  readonly automatic: boolean;
  readonly preferredKey: AuthorizedClientKey | undefined;
  rememberSuccessfulKey(fingerprint: string): Promise<void>;
}

export interface ResolveLocalSftpAuthenticationOptions {
  readonly password: string | undefined;
  readonly authorizedKeyPaths: readonly string[];
  readonly sshDirectory?: string;
  readonly stateFile: string;
  readonly agentPublicKeys?: readonly string[];
}

function fingerprint(key: ParsedKey): string {
  return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

function parsePublicKey(value: string | Buffer, source: string, privateKeyHint?: string): AuthorizedClientKey {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error) {
    throw new Error(`unable to parse SSH public key from ${source}: ${parsed.message}`);
  }
  return {
    key: parsed,
    fingerprint: fingerprint(parsed),
    source,
    ...(privateKeyHint ? { privateKeyHint } : {}),
  };
}

async function readPublicKeyFile(filePath: string): Promise<AuthorizedClientKey> {
  const resolved = path.resolve(filePath);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`SSH public key must be a regular non-symlink file: ${resolved}`);
  }
  return parsePublicKey(await fs.readFile(resolved), resolved, resolved.endsWith(".pub") ? resolved.slice(0, -4) : undefined);
}

async function discoverAgentPublicKeys(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ssh-add", ["-L"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function discoverPublicKeyFiles(sshDirectory: string): Promise<AuthorizedClientKey[]> {
  let entries;
  try {
    entries = await fs.readdir(sshDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".pub") && !entry.name.endsWith("-cert.pub"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const keys: AuthorizedClientKey[] = [];
  for (const fileName of fileNames) {
    try {
      keys.push(await readPublicKeyFile(path.join(sshDirectory, fileName)));
    } catch {
      // Automatic discovery skips unrelated or malformed .pub files.
    }
  }
  return keys;
}

function deduplicateKeys(keys: readonly AuthorizedClientKey[]): AuthorizedClientKey[] {
  const byFingerprint = new Map<string, AuthorizedClientKey>();
  for (const key of keys) {
    const existing = byFingerprint.get(key.fingerprint);
    if (!existing) {
      byFingerprint.set(key.fingerprint, key);
    } else if (!existing.privateKeyHint && key.privateKeyHint) {
      byFingerprint.set(key.fingerprint, { ...existing, privateKeyHint: key.privateKeyHint });
    }
  }
  return [...byFingerprint.values()];
}

async function readRememberedFingerprint(stateFile: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
      return undefined;
    }
    const value = (await fs.readFile(stateFile, "utf8")).trim();
    return value.startsWith("SHA256:") ? value : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function rememberFingerprint(stateFile: string, value: string): Promise<void> {
  const directory = path.dirname(stateFile);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(stateFile)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${value}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, stateFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function resolveLocalSftpAuthentication(
  options: ResolveLocalSftpAuthenticationOptions,
): Promise<LocalSftpAuthentication> {
  const explicitKeys = await Promise.all(options.authorizedKeyPaths.map((filePath) => readPublicKeyFile(filePath)));
  const explicitlyConfigured = options.password !== undefined || explicitKeys.length > 0;
  let authorizedKeys = deduplicateKeys(explicitKeys);
  let preferredKey = authorizedKeys[0];

  if (!explicitlyConfigured) {
    const agentLines = options.agentPublicKeys ?? (await discoverAgentPublicKeys());
    const agentKeys: AuthorizedClientKey[] = [];
    for (const line of agentLines) {
      try {
        agentKeys.push(parsePublicKey(line, "ssh-agent"));
      } catch {
        // Ignore malformed agent output and continue with usable identities.
      }
    }
    const sshDirectory = options.sshDirectory ?? path.join(os.homedir(), ".ssh");
    const discovered = deduplicateKeys([...agentKeys, ...(await discoverPublicKeyFiles(sshDirectory))]);
    if (discovered.length === 0) {
      throw new Error(
        "No usable SSH keys were found in ssh-agent or ~/.ssh. Create one with `ssh-keygen -t ed25519`, " +
          "then load it with `ssh-add ~/.ssh/id_ed25519`.",
      );
    }
    const remembered = await readRememberedFingerprint(options.stateFile);
    preferredKey = discovered.find((candidate) => candidate.fingerprint === remembered) ?? discovered[0];
    authorizedKeys = preferredKey ? [preferredKey] : [];
  }

  return {
    password: options.password,
    authorizedKeys,
    automatic: !explicitlyConfigured,
    preferredKey,
    rememberSuccessfulKey: async (successfulFingerprint: string) => {
      if (authorizedKeys.some((candidate) => candidate.fingerprint === successfulFingerprint)) {
        await rememberFingerprint(options.stateFile, successfulFingerprint);
      }
    },
  };
}

export function matchAndVerifyClientKey(
  authorizedKeys: readonly AuthorizedClientKey[],
  algorithm: string,
  publicKeyData: Buffer,
  blob: Buffer | undefined,
  signature: Buffer | undefined,
  hashAlgorithm: string | undefined,
): AuthorizedClientKey | undefined {
  const candidate = authorizedKeys.find((entry) => {
    const expected = entry.key.getPublicSSH();
    return entry.key.type === algorithm && expected.length === publicKeyData.length && timingSafeEqual(expected, publicKeyData);
  });
  if (!candidate) {
    return undefined;
  }
  if (!signature) {
    return candidate;
  }
  if (!blob || candidate.key.verify(blob, signature, hashAlgorithm) !== true) {
    return undefined;
  }
  return candidate;
}
