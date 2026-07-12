import type { Attributes, FileEntry } from "ssh2";
import type { ReadableFile } from "./readAheadFile.js";
import type { StagedFile } from "./stagedFile.js";

export interface ReadFileHandle {
  readonly kind: "read-file";
  readonly file: ReadableFile;
  readonly generation: number;
  readonly path: string;
  readonly attrs: Attributes;
}

export interface StagedFileHandle {
  readonly kind: "staged-file";
  readonly file: StagedFile;
  readonly generation: number;
  readonly path: string;
  readonly readable: boolean;
}

export interface DirectoryHandle {
  readonly kind: "directory";
  readonly generation: number;
  readonly path: string;
  readonly entries: FileEntry[];
  index: number;
}

export type SftpHandle = ReadFileHandle | StagedFileHandle | DirectoryHandle;

export class HandleTable {
  private nextId = 1;
  private readonly handles = new Map<string, SftpHandle>();

  public constructor(private readonly maximumHandles = 1024) {}

  public add(handle: SftpHandle): Buffer {
    if (this.handles.size >= this.maximumHandles) {
      throw new Error("too many concurrent SFTP handles");
    }
    const id = this.nextId++;
    const encoded = Buffer.allocUnsafe(4);
    encoded.writeUInt32BE(id);
    this.handles.set(encoded.toString("hex"), handle);
    return encoded;
  }

  public get(encoded: Buffer): SftpHandle | undefined {
    return this.handles.get(encoded.toString("hex"));
  }

  public take(encoded: Buffer): SftpHandle | undefined {
    const key = encoded.toString("hex");
    const handle = this.handles.get(key);
    this.handles.delete(key);
    return handle;
  }

  public values(): SftpHandle[] {
    return [...this.handles.values()];
  }

  public clear(): void {
    this.handles.clear();
  }
}
