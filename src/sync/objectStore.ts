import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function contentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export class ObjectStore {
  private readonly objectsDirectory: string;

  public constructor(stateDirectory: string) {
    this.objectsDirectory = path.join(stateDirectory, "objects");
  }

  public async put(content: Buffer): Promise<string> {
    const hash = contentHash(content);
    const destination = this.pathFor(hash);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(destination, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    return hash;
  }

  public async get(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Malformed object hash");
    }
    return fs.readFile(this.pathFor(hash));
  }

  public async writeConflict(pathHint: string, side: "local" | "remote", content: Buffer): Promise<string> {
    const safeHint = pathHint.replaceAll("/", "__").replace(/[^A-Za-z0-9_.-]/g, "_") || "root";
    const directory = path.join(this.objectsDirectory, "..", "conflicts");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${safeHint}.${side}.${Date.now()}-${randomUUID().slice(0, 8)}`);
    await fs.writeFile(destination, content, { mode: 0o600, flag: "wx" });
    return destination;
  }

  private pathFor(hash: string): string {
    return path.join(this.objectsDirectory, hash.slice(0, 2), hash.slice(2));
  }
}
