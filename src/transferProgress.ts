import { formatBytes } from "./logging.js";
import { LARGE_FILE_THRESHOLD_BYTES } from "./sync/transferPolicy.js";
import type { SyncProgress } from "./sync/types.js";

interface ProgressSink {
  info(message: string, fields?: Record<string, unknown>): void;
}

export class TransferProgressReporter {
  private readonly lastBucket = new Map<string, number>();

  public constructor(
    private readonly logger: ProgressSink,
    private readonly minimumBytes = LARGE_FILE_THRESHOLD_BYTES,
  ) {}

  public report(progress: SyncProgress): void {
    if (progress.totalBytes < this.minimumBytes || progress.totalBytes <= 0) return;
    const key = `${progress.direction}:${progress.path}`;
    if (progress.transferredBytes >= progress.totalBytes) {
      this.lastBucket.delete(key);
      return;
    }
    const percent = Math.max(0, Math.min(99, Math.floor((progress.transferredBytes / progress.totalBytes) * 100)));
    const bucket = Math.floor(percent / 10);
    if (progress.transferredBytes === 0) {
      this.lastBucket.set(key, 0);
    } else if (bucket <= (this.lastBucket.get(key) ?? -1)) {
      return;
    } else {
      this.lastBucket.set(key, bucket);
    }
    const arrow = progress.direction === "upload" ? "↑" : "↓";
    const verb = progress.direction === "upload" ? "Sending" : "Receiving";
    this.logger.info(`${arrow} ${verb} ${progress.path} ${progressBar(percent)} ${percent}%`, {
      transferred: formatBytes(progress.transferredBytes),
      total: formatBytes(progress.totalBytes),
    });
  }
}

function progressBar(percent: number): string {
  const width = 16;
  const complete = Math.floor((percent / 100) * width);
  return `[${"█".repeat(complete)}${"░".repeat(width - complete)}]`;
}
