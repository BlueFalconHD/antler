import type { RemoteFileSystemClient } from "../vscode/remoteFileSystem.js";

const READ_AHEAD_BYTES = 1024 * 1024;
const MAX_CACHED_WINDOWS = 2;

export interface ReadableFile {
  read(position: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export class InMemoryReadFile implements ReadableFile {
  private closed = false;

  public constructor(private content: Buffer) {}

  public async read(position: number, length: number): Promise<Buffer> {
    this.ensureOpen();
    validateRange(position, length);
    return this.content.subarray(position, Math.min(position + length, this.content.length));
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.content = Buffer.alloc(0);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("in-memory file is closed");
    }
  }
}

export class ReadAheadFile implements ReadableFile {
  private readonly windows = new Map<number, Promise<Buffer>>();
  private closed = false;

  public constructor(
    private readonly remote: RemoteFileSystemClient,
    private readonly remoteFd: number,
    private readonly size: number,
  ) {}

  public async read(position: number, length: number): Promise<Buffer> {
    this.ensureOpen();
    validateRange(position, length);
    const end = Math.min(this.size, position + length);
    if (position >= end) {
      return Buffer.alloc(0);
    }

    const firstWindow = Math.floor(position / READ_AHEAD_BYTES) * READ_AHEAD_BYTES;
    const windowStarts: number[] = [];
    for (let start = firstWindow; start < end; start += READ_AHEAD_BYTES) {
      windowStarts.push(start);
    }
    const buffers = await Promise.all(windowStarts.map((start) => this.window(start)));
    if (buffers.length === 1) {
      const offset = position - firstWindow;
      return buffers[0]!.subarray(offset, Math.min(offset + length, buffers[0]!.length));
    }

    const output = Buffer.allocUnsafe(end - position);
    let outputOffset = 0;
    for (let index = 0; index < buffers.length; index += 1) {
      const windowStart = windowStarts[index]!;
      const buffer = buffers[index]!;
      const sourceStart = Math.max(position, windowStart) - windowStart;
      const sourceEnd = Math.min(end, windowStart + buffer.length) - windowStart;
      if (sourceEnd <= sourceStart) {
        break;
      }
      buffer.copy(output, outputOffset, sourceStart, sourceEnd);
      outputOffset += sourceEnd - sourceStart;
    }
    return output.subarray(0, outputOffset);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.windows.clear();
    await this.remote.close(this.remoteFd);
  }

  private window(start: number): Promise<Buffer> {
    const cached = this.windows.get(start);
    if (cached) {
      this.windows.delete(start);
      this.windows.set(start, cached);
      return cached;
    }
    const request = this.fetchWindow(start);
    this.windows.set(start, request);
    void request.catch(() => {
      if (this.windows.get(start) === request) {
        this.windows.delete(start);
      }
    });
    while (this.windows.size > MAX_CACHED_WINDOWS) {
      const oldest = this.windows.keys().next().value as number | undefined;
      if (oldest === undefined) {
        break;
      }
      this.windows.delete(oldest);
    }
    return request;
  }

  private async fetchWindow(start: number): Promise<Buffer> {
    const expected = Math.min(READ_AHEAD_BYTES, this.size - start);
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < expected) {
      const chunk = await this.remote.read(this.remoteFd, start + bytesRead, expected - bytesRead);
      if (chunk.length === 0) {
        break;
      }
      chunks.push(chunk);
      bytesRead += chunk.length;
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesRead);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("read-ahead file is closed");
    }
  }
}

function validateRange(position: number, length: number): void {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position > Number.MAX_SAFE_INTEGER - length
  ) {
    throw new Error("invalid buffered read range");
  }
}
