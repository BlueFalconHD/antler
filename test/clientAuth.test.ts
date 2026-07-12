import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ssh2, { type ParsedKey } from "ssh2";
import {
  matchAndVerifyClientKey,
  resolveLocalSftpAuthentication,
} from "../src/sftp/clientAuth.js";

const { utils } = ssh2;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function testPaths(): Promise<{ root: string; ssh: string; state: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moose-proxy-auth-test-"));
  temporaryDirectories.push(root);
  const ssh = path.join(root, ".ssh");
  await fs.mkdir(ssh);
  return { root, ssh, state: path.join(root, "state", "last-key") };
}

function keyPair(): { private: string; public: string } {
  return utils.generateKeyPairSync("ed25519");
}

describe("local SFTP key discovery", () => {
  it("reuses the last key that successfully authenticated to the bridge", async () => {
    const paths = await testPaths();
    const first = keyPair();
    const second = keyPair();
    const secondOnly = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [second.public],
    });
    await secondOnly.rememberSuccessfulKey(secondOnly.preferredKey!.fingerprint);

    const resolved = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [first.public, second.public],
    });

    expect(resolved.automatic).toBe(true);
    expect(resolved.preferredKey?.fingerprint).toBe(secondOnly.preferredKey?.fingerprint);
    expect(resolved.authorizedKeys).toHaveLength(1);
  });

  it("falls back to the first ssh-agent identity when no remembered key is available", async () => {
    const paths = await testPaths();
    const first = keyPair();
    const second = keyPair();
    const expected = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [first.public],
    });
    const resolved = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [first.public, second.public],
    });
    expect(resolved.preferredKey?.fingerprint).toBe(expected.preferredKey?.fingerprint);
  });

  it("falls back to the first sorted public key file when the agent is empty", async () => {
    const paths = await testPaths();
    const first = keyPair();
    const second = keyPair();
    await fs.writeFile(path.join(paths.ssh, "z-last.pub"), second.public);
    await fs.writeFile(path.join(paths.ssh, "a-first.pub"), first.public);
    const resolved = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [],
    });
    expect(resolved.preferredKey?.privateKeyHint).toBe(path.join(paths.ssh, "a-first"));
  });

  it("instructs the user to run ssh-keygen when discovery finds no keys", async () => {
    const paths = await testPaths();
    await expect(
      resolveLocalSftpAuthentication({
        password: undefined,
        authorizedKeyPaths: [],
        sshDirectory: paths.ssh,
        stateFile: paths.state,
        agentPublicKeys: [],
      }),
    ).rejects.toThrow(/ssh-keygen -t ed25519/);
  });

  it("uses explicit password or public-key configuration without automatic discovery", async () => {
    const paths = await testPaths();
    const pair = keyPair();
    const publicKeyPath = path.join(paths.ssh, "explicit.pub");
    await fs.writeFile(publicKeyPath, pair.public);
    const keyAuth = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [publicKeyPath],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [],
    });
    expect(keyAuth.automatic).toBe(false);
    expect(keyAuth.authorizedKeys).toHaveLength(1);

    const passwordAuth = await resolveLocalSftpAuthentication({
      password: "local-only",
      authorizedKeyPaths: [],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [],
    });
    expect(passwordAuth.automatic).toBe(false);
    expect(passwordAuth.authorizedKeys).toHaveLength(0);
  });
});

describe("public-key signature verification", () => {
  it("accepts key probes and valid signatures but rejects invalid signatures", async () => {
    const paths = await testPaths();
    const pair = keyPair();
    const publicKeyPath = path.join(paths.ssh, "client.pub");
    await fs.writeFile(publicKeyPath, pair.public);
    const auth = await resolveLocalSftpAuthentication({
      password: undefined,
      authorizedKeyPaths: [publicKeyPath],
      sshDirectory: paths.ssh,
      stateFile: paths.state,
      agentPublicKeys: [],
    });
    const entry = auth.authorizedKeys[0]!;
    const privateKey = utils.parseKey(pair.private) as ParsedKey;
    const blob = randomBytes(64);
    const signature = privateKey.sign(blob);

    expect(matchAndVerifyClientKey(auth.authorizedKeys, entry.key.type, entry.key.getPublicSSH(), undefined, undefined, undefined)).toBe(entry);
    expect(matchAndVerifyClientKey(auth.authorizedKeys, entry.key.type, entry.key.getPublicSSH(), blob, signature, undefined)).toBe(entry);
    expect(
      matchAndVerifyClientKey(auth.authorizedKeys, entry.key.type, entry.key.getPublicSSH(), blob, randomBytes(signature.length), undefined),
    ).toBeUndefined();
  });
});
