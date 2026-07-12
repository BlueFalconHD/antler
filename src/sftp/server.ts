import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ssh2, {
  type AuthenticationType,
  type Attributes,
  type Connection,
  type FileEntry,
  type SFTPWrapper,
  type Server as SshServer,
} from "ssh2";
import { PathConfinement } from "../confinement/pathConfinement.js";
import type { Logger } from "../logging.js";
import type { RemoteAgentManager, RemoteFileSystemLease } from "../remoteAgentManager.js";
import { FileType } from "../vscode/remoteFileSystem.js";
import { stagedAttributes, symlinkListingAttributes, toAttributes, toFileEntry } from "./attributes.js";
import { SftpError, SFTP_STATUS, toSftpError } from "./errors.js";
import { HandleTable, type SftpHandle } from "./handleTable.js";
import { PathLockManager } from "./pathLocks.js";
import { ReadAheadFile } from "./readAheadFile.js";
import { StagedFile } from "./stagedFile.js";
import { matchAndVerifyClientKey, type LocalSftpAuthentication } from "./clientAuth.js";

const { Server, utils } = ssh2;
const OPEN_MODE = utils.sftp.OPEN_MODE;
const MAX_READ_BYTES = 1024 * 1024;
const DIRECTORY_PAGE_SIZE = 100;
const DIRECTORY_STAT_CONCURRENCY = 32;

export interface SftpServerOptions {
  readonly bindAddress: string;
  readonly port: number;
  readonly hostKeyPath: string;
  readonly username: string;
  readonly authentication: LocalSftpAuthentication;
  readonly remoteRoot: string;
  readonly stagingDirectory: string;
  readonly manager: RemoteAgentManager;
  readonly logger: Logger;
}

function passwordsEqual(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

async function ensureHostKey(hostKeyPath: string): Promise<Buffer> {
  try {
    const stat = await fs.lstat(hostKeyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("SSH host key path must be a regular non-symlink file");
    }
    await fs.chmod(hostKeyPath, 0o600);
    return await fs.readFile(hostKeyPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await fs.mkdir(path.dirname(hostKeyPath), { recursive: true, mode: 0o700 });
  const pair = utils.generateKeyPairSync("ed25519");
  await fs.writeFile(hostKeyPath, pair.private, { flag: "wx", mode: 0o600 });
  return Buffer.from(pair.private);
}

export class SftpBridgeServer {
  private server: SshServer | undefined;
  private readonly connections = new Set<Connection>();
  private readonly pathLocks = new PathLockManager();

  public constructor(private readonly options: SftpServerOptions) {}

  public get listeningPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("SFTP bridge is not listening on a TCP port");
    }
    return address.port;
  }

  public async start(): Promise<void> {
    const hostKey = await ensureHostKey(this.options.hostKeyPath);
    const server = new Server({ hostKeys: [hostKey], ident: "SSH-2.0-moose-proxy" });
    this.server = server;
    server.on("error", (error: Error) => this.options.logger.error("SFTP server error", { error }));
    server.on("connection", (client, info) => this.acceptClient(client, info.ip));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.bindAddress, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.options.logger.info("SFTP bridge listening", {
      address: this.options.bindAddress,
      port: this.listeningPort,
      username: this.options.username,
      remotePath: "/",
      privateKeyHint: this.options.authentication.preferredKey?.privateKeyHint,
      profile: "sftp-v3",
    });
  }

  public async stop(): Promise<void> {
    for (const connection of this.connections) {
      connection.end();
    }
    this.connections.clear();
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server?.close((error?: Error) => (error ? reject(error) : resolve())),
      );
      this.server = undefined;
    }
  }

  private acceptClient(client: Connection, remoteAddress: string): void {
    this.connections.add(client);
    this.options.logger.info("SFTP client connected", { remoteAddress });
    client.on("authentication", (context) => {
      const methods: AuthenticationType[] = [];
      if (this.options.authentication.authorizedKeys.length > 0) {
        methods.push("publickey");
      }
      if (this.options.authentication.password !== undefined) {
        methods.push("password");
      }
      if (context.username !== this.options.username) {
        context.reject(methods);
        return;
      }
      if (context.method === "password" && this.options.authentication.password !== undefined) {
        if (passwordsEqual(context.password, this.options.authentication.password)) {
          context.accept();
        } else {
          context.reject(methods);
        }
        return;
      }
      if (context.method === "publickey") {
        const matched = matchAndVerifyClientKey(
          this.options.authentication.authorizedKeys,
          context.key.algo,
          context.key.data,
          context.blob,
          context.signature,
          context.hashAlgo,
        );
        if (matched) {
          context.accept();
          if (context.signature) {
            void this.options.authentication.rememberSuccessfulKey(matched.fingerprint).catch((error: unknown) => {
              this.options.logger.warn("failed to remember successful SFTP client key", { error });
            });
          }
          return;
        }
      }
      context.reject(methods);
    });
    client.on("error", (error) => this.options.logger.warn("SFTP client transport error", { remoteAddress, error }));
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const subsystem = new SftpSubsystem(
            sftp,
            this.options.manager,
            this.options.remoteRoot,
            this.options.stagingDirectory,
            this.pathLocks,
            this.options.logger,
          );
          subsystem.install();
        });
      });
    });
    const cleanup = () => {
      this.connections.delete(client);
      this.options.logger.info("SFTP client disconnected", { remoteAddress });
    };
    client.once("close", cleanup);
  }
}

class SftpSubsystem {
  private readonly handles = new HandleTable();
  private cleaned = false;
  private readonly onManagerDisconnect = () => void this.cleanup();

  public constructor(
    private readonly sftp: SFTPWrapper,
    private readonly manager: RemoteAgentManager,
    private readonly remoteRoot: string,
    private readonly stagingDirectory: string,
    private readonly pathLocks: PathLockManager,
    private readonly logger: Logger,
  ) {}

  public install(): void {
    this.sftp.on("REALPATH", (id, requestPath) => this.respond(id, "REALPATH", () => this.realpath(id, requestPath)));
    this.sftp.on("STAT", (id, requestPath) => this.respond(id, "STAT", () => this.stat(id, requestPath)));
    this.sftp.on("LSTAT", (id, requestPath) => this.respond(id, "LSTAT", () => this.stat(id, requestPath)));
    this.sftp.on("OPENDIR", (id, requestPath) => this.respond(id, "OPENDIR", () => this.opendir(id, requestPath)));
    this.sftp.on("READDIR", (id, handle) => this.respond(id, "READDIR", () => this.readdir(id, handle)));
    this.sftp.on("OPEN", (id, filename, flags, attrs) =>
      this.respond(id, "OPEN", () => this.open(id, filename, flags, attrs)),
    );
    this.sftp.on("READ", (id, handle, offset, length) =>
      this.respond(id, "READ", () => this.read(id, handle, offset, length)),
    );
    this.sftp.on("WRITE", (id, handle, offset, data) =>
      this.respond(id, "WRITE", () => this.write(id, handle, offset, data)),
    );
    this.sftp.on("FSTAT", (id, handle) => this.respond(id, "FSTAT", () => this.fstat(id, handle)));
    this.sftp.on("FSETSTAT", (id, handle, attrs) =>
      this.respond(id, "FSETSTAT", () => this.fsetstat(id, handle, attrs)),
    );
    this.sftp.on("SETSTAT", (id, requestPath, attrs) =>
      this.respond(id, "SETSTAT", () => this.setstat(id, requestPath, attrs)),
    );
    this.sftp.on("CLOSE", (id, handle) => this.respond(id, "CLOSE", () => this.close(id, handle)));
    this.sftp.on("MKDIR", (id, requestPath, attrs) =>
      this.respond(id, "MKDIR", () => this.mkdir(id, requestPath, attrs)),
    );
    this.sftp.on("REMOVE", (id, requestPath) => this.respond(id, "REMOVE", () => this.remove(id, requestPath)));
    this.sftp.on("RMDIR", (id, requestPath) => this.respond(id, "RMDIR", () => this.rmdir(id, requestPath)));
    this.sftp.on("RENAME", (id, oldPath, newPath) =>
      this.respond(id, "RENAME", () => this.rename(id, oldPath, newPath)),
    );
    this.sftp.on("READLINK", (id) => this.unsupported(id));
    this.sftp.on("SYMLINK", (id) => this.unsupported(id));
    this.sftp.on("EXTENDED", (id) => this.unsupported(id));
    this.sftp.once("close", () => void this.cleanup());
    this.sftp.once("end", () => {
      void this.cleanup();
      this.sftp.end();
    });
    this.manager.on("disconnect", this.onManagerDisconnect);
  }

  private async lease(): Promise<{ lease: RemoteFileSystemLease; confinement: PathConfinement }> {
    const lease = await this.manager.get();
    return { lease, confinement: new PathConfinement(this.remoteRoot, lease.client) };
  }

  private async realpath(id: number, requestPath: string): Promise<void> {
    const { confinement } = await this.lease();
    const resolved = await confinement.existing(requestPath === "" ? "/" : requestPath);
    this.sftp.name(id, [toFileEntry(resolved.clientPath, toAttributes(resolved.stat!))]);
  }

  private async stat(id: number, requestPath: string): Promise<void> {
    const { confinement } = await this.lease();
    const resolved = await confinement.existing(requestPath);
    this.sftp.attrs(id, toAttributes(resolved.stat!));
  }

  private async opendir(id: number, requestPath: string): Promise<void> {
    const { lease, confinement } = await this.lease();
    const resolved = await confinement.existing(requestPath);
    if ((resolved.stat!.type & FileType.Directory) === 0) {
      throw new SftpError(SFTP_STATUS.FAILURE, "Not a directory");
    }
    const rawEntries = await lease.client.readdir(resolved.remotePath);
    const entries = await mapLimit(rawEntries, DIRECTORY_STAT_CONCURRENCY, async (entry): Promise<FileEntry> => {
      if (
        (entry.type & FileType.SymbolicLink) !== 0 ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name.includes("\0")
      ) {
        return toFileEntry(entry.name, symlinkListingAttributes());
      }
      try {
        const child = await confinement.childOfVerifiedDirectory(resolved, entry.name);
        return toFileEntry(entry.name, toAttributes(child.stat!));
      } catch (error) {
        if (error instanceof SftpError && error.status === SFTP_STATUS.PERMISSION_DENIED) {
          return toFileEntry(entry.name, symlinkListingAttributes());
        }
        throw error;
      }
    });
    const handle = this.handles.add({
      kind: "directory",
      generation: lease.generation,
      path: resolved.remotePath,
      entries,
      index: 0,
    });
    this.sftp.handle(id, handle);
  }

  private async readdir(id: number, encoded: Buffer): Promise<void> {
    const handle = this.requireHandle(encoded, "directory");
    this.manager.assertGeneration(handle.generation);
    if (handle.index >= handle.entries.length) {
      this.sftp.status(id, SFTP_STATUS.EOF);
      return;
    }
    const page = handle.entries.slice(handle.index, handle.index + DIRECTORY_PAGE_SIZE);
    handle.index += page.length;
    this.sftp.name(id, page);
  }

  private async open(id: number, filename: string, flags: number, attrs: Attributes): Promise<void> {
    rejectAttributes(attrs, [0o644, 0o666]);
    if ((flags & (OPEN_MODE.READ | OPEN_MODE.WRITE)) === 0 || ((flags & OPEN_MODE.EXCL) !== 0 && (flags & OPEN_MODE.CREAT) === 0)) {
      throw new SftpError(SFTP_STATUS.BAD_MESSAGE, "Invalid open flags");
    }
    const { lease, confinement } = await this.lease();
    if ((flags & OPEN_MODE.WRITE) === 0) {
      const resolved = await confinement.existing(filename);
      requireRegularFile(resolved.stat!);
      const remoteFd = await lease.client.openRead(resolved.remotePath);
      const handle = this.handles.add({
        kind: "read-file",
        file: new ReadAheadFile(lease.client, remoteFd, resolved.stat!.size),
        generation: lease.generation,
        path: resolved.remotePath,
        attrs: toAttributes(resolved.stat!),
      });
      this.sftp.handle(id, handle);
      return;
    }

    const mapped = confinement.map(filename);
    const releaseLock = await this.pathLocks.acquire(mapped.remotePath);
    try {
      const resolved = await confinement.forCreate(filename);
      if (resolved.stat) {
        requireRegularFile(resolved.stat);
        if ((flags & OPEN_MODE.EXCL) !== 0) {
          throw new SftpError(SFTP_STATUS.FAILURE, "File already exists");
        }
      } else if ((flags & OPEN_MODE.CREAT) === 0) {
        throw new SftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file");
      }
      const preserveExisting = resolved.stat !== undefined && (flags & OPEN_MODE.TRUNC) === 0;
      let staged: StagedFile | undefined;
      try {
        staged = await StagedFile.create({
          remote: lease.client,
          remotePath: resolved.remotePath,
          stagingDirectory: this.stagingDirectory,
          existingStat: resolved.stat,
          preserveExisting,
          append: (flags & OPEN_MODE.APPEND) !== 0,
          releaseLock,
          verifyConfinement: async () => {
            const current = await confinement.forCreate(filename);
            if (current.stat) {
              requireRegularFile(current.stat);
            }
          },
        });
        const handle = this.handles.add({
          kind: "staged-file",
          file: staged,
          generation: lease.generation,
          path: resolved.remotePath,
          readable: (flags & OPEN_MODE.READ) !== 0,
        });
        this.sftp.handle(id, handle);
      } catch (error) {
        await staged?.abort();
        throw error;
      }
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  private async read(id: number, encoded: Buffer, offset: number, length: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || length > MAX_READ_BYTES) {
      throw new SftpError(SFTP_STATUS.BAD_MESSAGE, "Invalid read range");
    }
    const handle = this.requireHandle(encoded);
    this.manager.assertGeneration(handle.generation);
    let data: Buffer;
    if (handle.kind === "read-file") {
      data = await handle.file.read(offset, length);
    } else if (handle.kind === "staged-file" && handle.readable) {
      data = await handle.file.read(offset, length);
    } else {
      throw new SftpError(SFTP_STATUS.FAILURE, "Handle is not readable");
    }
    if (data.length === 0) {
      this.sftp.status(id, SFTP_STATUS.EOF);
    } else {
      this.sftp.data(id, data);
    }
  }

  private async write(id: number, encoded: Buffer, offset: number, data: Buffer): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new SftpError(SFTP_STATUS.BAD_MESSAGE, "Invalid write offset");
    }
    const handle = this.requireHandle(encoded, "staged-file");
    this.manager.assertGeneration(handle.generation);
    await handle.file.write(offset, data);
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private async fstat(id: number, encoded: Buffer): Promise<void> {
    const handle = this.requireHandle(encoded);
    this.manager.assertGeneration(handle.generation);
    if (handle.kind === "read-file") {
      this.sftp.attrs(id, handle.attrs);
    } else if (handle.kind === "staged-file") {
      this.sftp.attrs(id, stagedAttributes(await handle.file.stat()));
    } else {
      throw new SftpError(SFTP_STATUS.FAILURE, "Directory handle has no file attributes");
    }
  }

  private async fsetstat(id: number, encoded: Buffer, attrs: Attributes): Promise<void> {
    const size = requireSizeOnly(attrs);
    const handle = this.requireHandle(encoded, "staged-file");
    this.manager.assertGeneration(handle.generation);
    await handle.file.truncate(size);
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private async setstat(id: number, requestPath: string, attrs: Attributes): Promise<void> {
    const size = requireSizeOnly(attrs);
    const { lease, confinement } = await this.lease();
    const mapped = confinement.map(requestPath);
    const releaseLock = await this.pathLocks.acquire(mapped.remotePath);
    try {
      const resolved = await confinement.existing(requestPath);
      requireRegularFile(resolved.stat!);
      const staged = await StagedFile.create({
        remote: lease.client,
        remotePath: resolved.remotePath,
        stagingDirectory: this.stagingDirectory,
        existingStat: resolved.stat,
        preserveExisting: true,
        append: false,
        releaseLock,
        verifyConfinement: async () => {
          const current = await confinement.existing(requestPath);
          requireRegularFile(current.stat!);
        },
      });
      try {
        await staged.truncate(size);
        this.manager.assertGeneration(lease.generation);
        await staged.commit();
      } catch (error) {
        await staged.abort();
        throw error;
      }
      this.sftp.status(id, SFTP_STATUS.OK);
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  private async close(id: number, encoded: Buffer): Promise<void> {
    const handle = this.handles.take(encoded);
    if (!handle) {
      throw new SftpError(SFTP_STATUS.FAILURE, "Invalid handle");
    }
    if (handle.kind === "read-file") {
      this.manager.assertGeneration(handle.generation);
      await handle.file.close();
    } else if (handle.kind === "staged-file") {
      try {
        this.manager.assertGeneration(handle.generation);
        const result = await handle.file.commit();
        this.logger.debug("SFTP staged file committed", {
          path: handle.path,
          strategy: result.strategy,
          changedRangeBytes: result.changedRangeBytes,
          transferredBytes: result.transferredBytes,
          originalSize: result.originalSize,
          finalSize: result.finalSize,
        });
      } catch (error) {
        await handle.file.abort();
        throw error;
      }
    }
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private async mkdir(id: number, requestPath: string, attrs: Attributes): Promise<void> {
    rejectAttributes(attrs, [0o755, 0o777]);
    const { lease, confinement } = await this.lease();
    const resolved = await confinement.forCreate(requestPath);
    if (resolved.stat) {
      throw new SftpError(SFTP_STATUS.FAILURE, "File already exists");
    }
    await lease.client.mkdir(resolved.remotePath);
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private async remove(id: number, requestPath: string): Promise<void> {
    const { lease, confinement } = await this.lease();
    const resolved = await confinement.existing(requestPath);
    requireRegularFile(resolved.stat!);
    await lease.client.delete(resolved.remotePath, false);
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private async rmdir(id: number, requestPath: string): Promise<void> {
    const { lease, confinement } = await this.lease();
    const resolved = await confinement.existing(requestPath);
    if (resolved.remotePath === confinement.remoteRoot) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Cannot remove configured root");
    }
    if ((resolved.stat!.type & FileType.Directory) === 0) {
      throw new SftpError(SFTP_STATUS.FAILURE, "Not a directory");
    }
    await lease.client.delete(resolved.remotePath, false);
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private async rename(id: number, oldPath: string, newPath: string): Promise<void> {
    const { lease, confinement } = await this.lease();
    const source = await confinement.existing(oldPath);
    const destination = await confinement.forCreate(newPath);
    if (source.remotePath === confinement.remoteRoot || destination.remotePath === confinement.remoteRoot) {
      throw new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Cannot rename configured root");
    }
    if (destination.stat) {
      throw new SftpError(SFTP_STATUS.FAILURE, "Destination already exists");
    }
    await lease.client.rename(source.remotePath, destination.remotePath, false);
    this.sftp.status(id, SFTP_STATUS.OK);
  }

  private requireHandle<T extends SftpHandle["kind"]>(encoded: Buffer, kind?: T): Extract<SftpHandle, { kind: T }>;
  private requireHandle(encoded: Buffer, kind?: undefined): SftpHandle;
  private requireHandle(encoded: Buffer, kind?: SftpHandle["kind"]): SftpHandle {
    const handle = this.handles.get(encoded);
    if (!handle || (kind && handle.kind !== kind)) {
      throw new SftpError(SFTP_STATUS.FAILURE, "Invalid handle");
    }
    return handle;
  }

  private unsupported(id: number): void {
    this.sftp.status(id, SFTP_STATUS.OP_UNSUPPORTED, "Operation is not supported by remoteFilesystem");
  }

  private respond(id: number, name: string, operation: () => Promise<void>): void {
    const startedAt = performance.now();
    void operation().then(
      () => this.logger.debug("SFTP operation completed", { operation: name, durationMs: performance.now() - startedAt }),
      (error: unknown) => {
        const translated = toSftpError(error);
        this.logger.warn("SFTP operation failed", {
          operation: name,
          durationMs: performance.now() - startedAt,
          status: translated.status,
          error,
        });
        this.sftp.status(id, translated.status, translated.message);
      },
    );
  }

  private async cleanup(): Promise<void> {
    if (this.cleaned) {
      return;
    }
    this.cleaned = true;
    this.manager.off("disconnect", this.onManagerDisconnect);
    const handles = this.handles.values();
    this.handles.clear();
    for (const handle of handles) {
      try {
        if (handle.kind === "staged-file") {
          await handle.file.abort();
        } else if (handle.kind === "read-file") {
          this.manager.assertGeneration(handle.generation);
          await handle.file.close();
        }
      } catch {
        // Cleanup is best effort after channel/connection loss.
      }
    }
  }
}

function rejectAttributes(attrs: Attributes, allowedModes: readonly number[] = []): void {
  const keys = Object.keys(attrs).filter((key) => (attrs as unknown as Record<string, unknown>)[key] !== undefined);
  const unsupportedKeys = keys.filter((key) => key !== "mode");
  const mode = typeof attrs.mode === "number" ? attrs.mode & 0o7777 : undefined;
  if (unsupportedKeys.length > 0 || (mode !== undefined && !allowedModes.includes(mode))) {
    throw new SftpError(SFTP_STATUS.OP_UNSUPPORTED, "Mode, ownership, and timestamp attributes are unsupported");
  }
}

function requireSizeOnly(attrs: Attributes): number {
  const keys = Object.keys(attrs).filter((key) => (attrs as unknown as Record<string, unknown>)[key] !== undefined);
  if (keys.length !== 1 || keys[0] !== "size" || !Number.isSafeInteger(attrs.size) || attrs.size < 0) {
    throw new SftpError(SFTP_STATUS.OP_UNSUPPORTED, "Only file size changes are supported");
  }
  return attrs.size;
}

function requireRegularFile(stat: { type: number }): void {
  if ((stat.type & FileType.File) === 0 || (stat.type & (FileType.Directory | FileType.SymbolicLink)) !== 0) {
    throw new SftpError(SFTP_STATUS.FAILURE, "Not a regular file");
  }
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const current = index++;
      const value = values[current];
      if (value === undefined) {
        return;
      }
      result[current] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return result;
}
