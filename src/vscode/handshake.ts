import { randomUUID } from "node:crypto";
import type { CodeServerSession } from "../auth/codeServerAuth.js";
import type { CompatibilityProfile } from "../compatibility/profiles.js";
import { remoteAgentPath } from "../compatibility/profiles.js";
import { WebSocketTransport } from "../transport/webSocketTransport.js";
import { IpcClient } from "./ipcClient.js";
import { PersistentProtocol } from "./persistentProtocol.js";

export interface RemoteAgentConnectionOptions {
  readonly session: CodeServerSession;
  readonly profile: CompatibilityProfile;
  readonly rejectUnauthorized: boolean;
  readonly sendOrigin: boolean;
  readonly timeoutMs?: number;
}

export interface RemoteAgentConnection {
  readonly protocol: PersistentProtocol;
  readonly ipc: IpcClient;
  readonly remoteAuthority: string;
  readonly reconnectionToken: string;
  close(): Promise<void>;
}

function websocketUrl(baseUrl: URL, profile: CompatibilityProfile, reconnectionToken: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${remoteAgentPath(profile)}`.replace(/\/{2,}/g, "/");
  url.search = new URLSearchParams({
    reconnectionToken,
    reconnection: "false",
    skipWebSocketFrames: "false",
  }).toString();
  url.hash = "";
  return url;
}

function waitForControl(protocol: PersistentProtocol, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("VS Code remote-agent handshake timed out"));
    }, timeoutMs);
    const onControl = (raw: Buffer) => {
      cleanup();
      try {
        const value = JSON.parse(raw.toString("utf8"));
        if (!value || typeof value !== "object") {
          throw new Error("handshake control message is not an object");
        }
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      protocol.off("control", onControl);
      protocol.off("close", onClose);
    };
    protocol.once("control", onControl);
    protocol.once("close", onClose);
  });
}

export async function connectRemoteAgent(options: RemoteAgentConnectionOptions): Promise<RemoteAgentConnection> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const reconnectionToken = randomUUID();
  const url = websocketUrl(options.session.baseUrl, options.profile, reconnectionToken);
  const cookie = await options.session.cookieHeader(url);
  const transport = await WebSocketTransport.connect({
    url,
    cookie,
    rejectUnauthorized: options.rejectUnauthorized,
    ...(options.sendOrigin ? { origin: options.session.baseUrl.origin } : {}),
  });
  const protocol = new PersistentProtocol(transport);
  const authData = randomUUID();
  const signResponse = waitForControl(protocol, timeoutMs);
  await protocol.sendControl(
    Buffer.from(
      JSON.stringify({ type: "auth", auth: "00000000000000000000", data: authData }),
      "utf8",
    ),
  );
  const sign = await signResponse;
  if (sign.type !== "sign" || typeof sign.data !== "string") {
    await protocol.disconnect();
    throw new Error(`unexpected remote-agent handshake response: ${String(sign.type)}`);
  }
  const confirmationResponse = waitForControl(protocol, timeoutMs);
  await protocol.sendControl(
    Buffer.from(
      JSON.stringify({
        type: "connectionType",
        commit: options.profile.productCommit,
        signedData: sign.data,
        desiredConnectionType: 1,
      }),
      "utf8",
    ),
  );
  const confirmation = await confirmationResponse;
  if (confirmation.type === "error") {
    await protocol.disconnect();
    throw new Error(`remote-agent rejected connection: ${String(confirmation.reason ?? "unknown reason")}`);
  }
  if (confirmation.type !== "ok") {
    await protocol.disconnect();
    throw new Error(`unexpected remote-agent confirmation: ${String(confirmation.type)}`);
  }

  const remoteAuthority = options.session.baseUrl.host;
  const ipc = new IpcClient(protocol);
  await ipc.start({ remoteAuthority, clientId: "renderer" });
  return {
    protocol,
    ipc,
    remoteAuthority,
    reconnectionToken,
    close: async () => {
      ipc.dispose();
      await protocol.disconnect();
    },
  };
}
