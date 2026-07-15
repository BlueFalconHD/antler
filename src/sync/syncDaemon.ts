import type { Logger } from "../logging.js";
import type { DeletePolicy } from "../projectConfig.js";
import type { RemoteAgentManager } from "../remoteAgentManager.js";
import { isConnectionError } from "../vscode/errors.js";
import { SyncEngine, type ReconcileOptions } from "./syncEngine.js";
import type { ReconcileResult } from "./types.js";
import { watchLocal, watchRemote, type ChangeWatcher, type LocalWatchErrorSource } from "./watchers.js";

export interface SyncDaemonOptions {
  readonly localRoot: string;
  readonly remoteRoot: string;
  readonly manager: RemoteAgentManager;
  readonly engine: SyncEngine;
  readonly logger: Logger;
  readonly debounceMilliseconds: number;
  readonly reconciliationIntervalSeconds: number;
  readonly deletePolicy: DeletePolicy;
}

interface RequestedReconciliation {
  readonly options: ReconcileOptions;
  readonly resolve: (result: ReconcileResult) => void;
  readonly reject: (error: unknown) => void;
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
  private localRestart: Promise<void> | undefined;
  private started = false;
  private readonly requestedReconciliations: RequestedReconciliation[] = [];

  public constructor(private readonly options: SyncDaemonOptions) {}

  public async start(): Promise<void> {
    this.localWatcher = watchLocal(
      this.options.localRoot,
      (paths) => this.schedule(paths),
      (error, source) => this.handleLocalWatcherError(error, source),
    );
    await this.installRemoteWatcher();
    this.running = true;
    let initial;
    try {
      initial = await this.options.engine.reconcile(this.applyDeletePolicy());
    } finally {
      this.running = false;
    }
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
    this.started = true;
    if (this.hasQueuedWork()) this.scheduleDrain();
  }

  public requestReconciliation(options: ReconcileOptions): Promise<ReconcileResult> {
    if (!this.started || this.stopped) {
      return Promise.reject(new Error("Live synchronization is not accepting requests"));
    }
    return new Promise((resolve, reject) => {
      this.requestedReconciliations.push({ options, resolve, reject });
      this.scheduleDrain(true);
    });
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    for (const request of this.requestedReconciliations.splice(0)) {
      request.reject(new Error("Live synchronization stopped before the request could run"));
    }
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.options.manager.off("disconnect", this.onDisconnect);
    const watchers = [this.localWatcher, this.remoteWatcher].filter((value): value is ChangeWatcher => Boolean(value));
    this.localWatcher = undefined;
    this.remoteWatcher = undefined;
    await Promise.allSettled(watchers.map((watcher) => watcher.close()));
    await this.localRestart?.catch(() => undefined);
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

  private scheduleDrain(immediate = false): void {
    if (this.stopped) return;
    if (immediate && this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.drain();
    }, immediate ? 0 : this.options.debounceMilliseconds);
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && this.hasQueuedWork()) {
        const requested = this.requestedReconciliations.shift();
        if (requested) {
          try {
            const result = await this.options.engine.reconcile(this.applyDeletePolicy(requested.options));
            requested.resolve(result);
          } catch (error) {
            requested.reject(error);
            if (isConnectionError(error)) {
              this.fullRequested = true;
              void this.reconnect();
              break;
            }
          }
          continue;
        }
        const full = this.fullRequested;
        const paths = [...this.pendingPaths];
        this.fullRequested = false;
        this.pendingPaths.clear();
        try {
          const result = await this.options.engine.reconcile(this.applyDeletePolicy(full ? {} : { paths }));
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
      if (!this.stopped && this.hasQueuedWork() && !this.reconnecting) {
        this.scheduleDrain();
      }
    }
  }

  private applyDeletePolicy(options: ReconcileOptions = {}): ReconcileOptions {
    if (this.options.deletePolicy !== "allow" || options.approveDeletes) return options;
    return { ...options, approveDeletes: true };
  }

  private hasQueuedWork(): boolean {
    return this.fullRequested || this.pendingPaths.size > 0 || this.requestedReconciliations.length > 0;
  }

  private readonly onDisconnect = (): void => {
    this.options.logger.warn("Remote connection lost. Local changes remain queued");
    this.fullRequested = true;
    void this.reconnect();
  };

  private handleLocalWatcherError(error: Error, source: LocalWatchErrorSource): void {
    this.fullRequested = true;
    if (source === "event") {
      this.options.logger.warn("Local watcher ignored a malformed event. Reconciliation requested", { error });
      this.scheduleDrain();
      return;
    }
    if (this.localRestart) return;
    this.options.logger.warn("Local watcher failed. Restarting once", { error });
    void this.restartLocalWatcher().catch((restartError: unknown) => {
      this.options.logger.error("Local watcher restart failed. Periodic reconciliation remains active", {
        error: restartError,
      });
      this.scheduleDrain();
    });
  }

  private handleRemoteWatcherError(error: Error): void {
    this.options.logger.warn("Remote watcher requested reconciliation", { error });
    this.fullRequested = true;
    void this.reconnect();
  }

  private async installRemoteWatcher(): Promise<void> {
    this.remoteWatcher = await watchRemote(
      this.options.manager,
      this.options.remoteRoot,
      (paths) => this.schedule(paths),
      (error) => this.handleRemoteWatcherError(error),
    );
  }

  private restartLocalWatcher(): Promise<void> {
    if (!this.localRestart) {
      this.localRestart = this.replaceLocalWatcher().finally(() => {
        this.localRestart = undefined;
      });
    }
    return this.localRestart;
  }

  private async replaceLocalWatcher(): Promise<void> {
    const previous = this.localWatcher;
    this.localWatcher = undefined;
    await previous?.close().catch(() => undefined);
    if (this.stopped) return;
    this.localWatcher = watchLocal(
      this.options.localRoot,
      (paths) => this.schedule(paths),
      (error, source) => this.handleLocalWatcherError(error, source),
    );
    this.scheduleDrain();
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
          this.options.logger.success("Remote connection restored. Verifying both trees");
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
