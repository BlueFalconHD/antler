import { describe, expect, it, vi } from "vitest";
import type { IpcClient, IpcSubscription } from "../src/vscode/ipcClient.js";
import { FileChangeType, RemoteFileSystemClient } from "../src/vscode/remoteFileSystem.js";

describe("remoteFilesystem watch", () => {
  it("installs the event listener before watch and cleans up in reverse order", async () => {
    const operations: string[] = [];
    let onEvent: ((value: unknown) => void) | undefined;
    const subscription: IpcSubscription = {
      dispose: async () => { operations.push("event-dispose"); },
    };
    const ipc = {
      listen: async (_channel: string, _event: string, _argument: unknown, callback: (value: unknown) => void) => {
        operations.push("event-listen");
        onEvent = callback;
        return subscription;
      },
      call: async (_channel: string, command: string) => {
        operations.push(command);
        return undefined;
      },
    } as unknown as IpcClient;
    const client = new RemoteFileSystemClient(ipc, "example.test");
    const changes = vi.fn();
    const errors = vi.fn();
    const watcher = await client.watch("/srv/project", changes, errors);
    expect(operations).toEqual(["event-listen", "watch"]);
    onEvent?.([{
      resource: { scheme: "vscode-remote", authority: "example.test", path: "/srv/project/a.txt" },
      type: FileChangeType.Added,
    }]);
    expect(changes).toHaveBeenCalledWith([{ path: "/srv/project/a.txt", type: FileChangeType.Added }]);
    await watcher.dispose();
    await watcher.dispose();
    expect(operations).toEqual(["event-listen", "watch", "unwatch", "event-dispose"]);
  });

  it("reports watcher errors and malformed/out-of-authority events", async () => {
    let onEvent: ((value: unknown) => void) | undefined;
    const ipc = {
      listen: async (_channel: string, _event: string, _argument: unknown, callback: (value: unknown) => void) => {
        onEvent = callback;
        return { dispose: async () => undefined };
      },
      call: async () => undefined,
    } as unknown as IpcClient;
    const client = new RemoteFileSystemClient(ipc, "example.test");
    const errors = vi.fn();
    await client.watch("/srv/project", () => undefined, errors);
    onEvent?.("native watcher failed");
    onEvent?.([{
      resource: { scheme: "vscode-remote", authority: "attacker.test", path: "/srv/project/a" },
      type: 1,
    }]);
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
