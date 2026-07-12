import type { Logger } from "../logging.js";
import type { RemoteAgentManager } from "../remoteAgentManager.js";
import { isConnectionError } from "../vscode/errors.js";
import { SyncEngine } from "./syncEngine.js";
import { watchLocal, watchRemote, type ChangeWatcher } from "./watchers.js";

export interface SyncDaemonOptions {
  readonly localRoot: string;
  readonly remoteRoot: string;
  readonly manager: RemoteAgentManager;
  readonly engine: SyncEngine;
  readonly logger: Logger;
  readonly debounceMilliseconds: number;
  readonly reconciliationIntervalSeconds: number;
}

export class SyncDaemon {
  private localWatcher: ChangeWatcher | undefined;
  private remoteWatcher: ChangeWatcher | undefined;
  private periodicTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly pendingPaths = new Set<string>();
  private fullRequested = false;
  private running = false;
  private stopped = false;
  private reconnecting = false;

  public constructor(private readonly options: SyncDaemonOptions) {}

  public async start(): Promise<void> {
    this.localWatcher = watchLocal(
      this.options.localRoot,
      (paths) => this.schedule(paths),
      (error) => this.handleWatcherError("local", error),
    );
    await this.installRemoteWatcher();
    const initial = await this.options.engine.reconcile();
    this.options.logger.success("Initial reconciliation complete", {
      conflicts: initial.conflicts,
      pendingDeletes: initial.pendingDeletes,
      transferredBytes: initial.transferredBytes,
    });
    this.periodicTimer = setInterval(() => {
      this.fullRequested = true;
      this.scheduleDrain();
    }, this.options.reconciliationIntervalSeconds * 1000);
    this.options.manager.on("disconnect", this.onDisconnect);
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.options.manager.off("disconnect", this.onDisconnect);
    const watchers = [this.localWatcher, this.remoteWatcher].filter((value): value is ChangeWatcher => Boolean(value));
    this.localWatcher = undefined;
    this.remoteWatcher = undefined;
    await Promise.allSettled(watchers.map((watcher) => watcher.close()));
    while (this.running) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  private schedule(paths: readonly string[]): void {
    if (paths.length === 0) {
      this.fullRequested = true;
    } else {
      for (const path of paths) this.pendingPaths.add(path);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.stopped || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.drain();
    }, this.options.debounceMilliseconds);
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && (this.fullRequested || this.pendingPaths.size > 0)) {
        const full = this.fullRequested;
        const paths = [...this.pendingPaths];
        this.fullRequested = false;
        this.pendingPaths.clear();
        try {
          const result = await this.options.engine.reconcile(full ? {} : { paths });
          if (result.conflicts > 0 || result.pendingDeletes > 0) {
            this.options.logger.warn("Synchronization needs attention", {
              conflicts: result.conflicts,
              pendingDeletes: result.pendingDeletes,
            });
          }
        } catch (error) {
          this.options.logger.error("Synchronization pass failed", { error });
          this.fullRequested = true;
          if (isConnectionError(error)) {
            void this.reconnect();
            break;
          }
          break;
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped && (this.fullRequested || this.pendingPaths.size > 0) && !this.reconnecting) {
        this.scheduleDrain();
      }
    }
  }

  private readonly onDisconnect = (): void => {
    this.options.logger.warn("Remote connection lost; local changes remain queued");
    this.fullRequested = true;
    void this.reconnect();
  };

  private handleWatcherError(side: "local" | "remote", error: Error): void {
    this.options.logger.warn(`${side === "local" ? "Local" : "Remote"} watcher requested reconciliation`, { error });
    this.fullRequested = true;
    if (side === "remote" && isConnectionError(error)) {
      void this.reconnect();
    } else {
      this.scheduleDrain();
    }
  }

  private async installRemoteWatcher(): Promise<void> {
    this.remoteWatcher = await watchRemote(
      this.options.manager,
      this.options.remoteRoot,
      (paths) => this.schedule(paths),
      (error) => this.handleWatcherError("remote", error),
    );
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    await this.remoteWatcher?.close().catch(() => undefined);
    this.remoteWatcher = undefined;
    let delay = 500;
    try {
      while (!this.stopped) {
        try {
          await this.options.manager.get();
          await this.installRemoteWatcher();
          this.options.logger.success("Remote connection restored; verifying both trees");
          this.fullRequested = true;
          return;
        } catch (error) {
          this.options.logger.warn("Reconnect attempt failed", { retryInMs: delay, error });
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 15_000);
        }
      }
    } finally {
      this.reconnecting = false;
      if (this.fullRequested) this.scheduleDrain();
    }
  }
}
