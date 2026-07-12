import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { IpcClient } from "../src/vscode/ipcClient.js";
import type { PersistentProtocol } from "../src/vscode/persistentProtocol.js";
import { deserialize, Reader, serialize } from "../src/vscode/serialization.js";

class FakeProtocol extends EventEmitter {
  public readonly sent: Buffer[] = [];
  public async sendRegular(message: Buffer): Promise<void> {
    this.sent.push(message);
  }
}

function decode(message: Buffer): [unknown, unknown] {
  const reader = new Reader(message);
  return [deserialize(reader), deserialize(reader)];
}

async function initializedClient(): Promise<{ client: IpcClient; protocol: FakeProtocol }> {
  const protocol = new FakeProtocol();
  const client = new IpcClient(protocol as unknown as PersistentProtocol);
  const start = client.start({ remoteAuthority: "test", clientId: "renderer" });
  protocol.emit("message", serialize([200], undefined));
  await start;
  return { client, protocol };
}

describe("VS Code IPC events", () => {
  it("sends event listen, routes event fire, and disposes with the same id", async () => {
    const { client, protocol } = await initializedClient();
    const received: unknown[] = [];
    const subscription = await client.listen("remoteFilesystem", "fileChange", ["session"], (event) => received.push(event));
    expect(decode(protocol.sent[2]!)).toEqual([[102, 0, "remoteFilesystem", "fileChange"], ["session"]]);

    protocol.emit("message", serialize([204, 0], [{ type: 1 }]));
    expect(received).toEqual([[{ type: 1 }]]);
    await subscription.dispose();
    expect(decode(protocol.sent[3]!)).toEqual([[103, 0], undefined]);
  });

  it("shares request ids with calls and isolates callback failures", async () => {
    const { client, protocol } = await initializedClient();
    await client.listen("remoteFilesystem", "fileChange", [], () => {
      throw new Error("consumer failed");
    });
    const response = client.call("remoteFilesystem", "stat", []);
    expect(decode(protocol.sent[3]!)[0]).toEqual([100, 1, "remoteFilesystem", "stat"]);
    protocol.emit("message", serialize([204, 0], "event"));
    protocol.emit("message", serialize([201, 1], { size: 1 }));
    await expect(response).resolves.toEqual({ size: 1 });
  });

  it("closes subscriptions exactly once when the transport fails", async () => {
    const { client, protocol } = await initializedClient();
    const onClose = vi.fn();
    const subscription = await client.listen("remoteFilesystem", "fileChange", [], () => undefined, onClose);
    protocol.emit("close", new Error("lost"));
    expect(onClose).toHaveBeenCalledOnce();
    await subscription.dispose();
    expect(protocol.sent).toHaveLength(3);
  });
});
