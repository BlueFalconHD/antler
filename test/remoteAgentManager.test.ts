import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { CodeServerSession } from "../src/auth/codeServerAuth.js";
import { compatibilityProfiles } from "../src/compatibility/profiles.js";
import { RemoteAgentManager } from "../src/remoteAgentManager.js";
import type { RemoteAgentConnection } from "../src/vscode/handshake.js";
import type { IpcClient } from "../src/vscode/ipcClient.js";
import type { PersistentProtocol } from "../src/vscode/persistentProtocol.js";

describe("remote connection loss", () => {
  it("invalidates old handles and reconnects future operations", async () => {
    const protocols: EventEmitter[] = [];
    const manager = new RemoteAgentManager({
      session: { close: async () => undefined } as CodeServerSession,
      profile: compatibilityProfiles["public-v4.20.1"],
      rejectUnauthorized: true,
      sendOrigin: true,
      connector: async () => {
        const protocol = new EventEmitter();
        protocols.push(protocol);
        return {
          protocol: protocol as PersistentProtocol,
          ipc: {} as IpcClient,
          remoteAuthority: "example.test",
          reconnectionToken: "test",
          close: async () => undefined,
        } satisfies RemoteAgentConnection;
      },
    });

    const first = await manager.get();
    expect(first.generation).toBe(1);
    protocols[0]?.emit("close", new Error("lost"));
    expect(() => manager.assertGeneration(first.generation)).toThrow(/no longer valid/);
    const second = await manager.get();
    expect(second.generation).toBe(2);
    await manager.stop();
  });
});
