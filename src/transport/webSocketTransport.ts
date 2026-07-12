import { EventEmitter } from "node:events";
import WebSocket, { type ClientOptions, type RawData } from "ws";

export interface WebSocketTransportOptions {
  readonly url: URL;
  readonly cookie: string;
  readonly origin?: string;
  readonly rejectUnauthorized: boolean;
  readonly maxPayloadBytes?: number;
  readonly highWaterMarkBytes?: number;
}

export class WebSocketTransport extends EventEmitter {
  private readonly socket: WebSocket;
  private readonly highWaterMark: number;
  private closed = false;

  private constructor(socket: WebSocket, highWaterMark: number) {
    super();
    this.socket = socket;
    this.highWaterMark = highWaterMark;
    socket.on("message", (data: RawData) => this.emit("data", this.toBuffer(data)));
    socket.on("error", (error) => this.emit("transportError", error));
    socket.on("close", (code, reason) => {
      this.closed = true;
      this.emit("close", new Error(`remote WebSocket closed (${code} ${reason.toString()})`));
    });
  }

  public static connect(options: WebSocketTransportOptions): Promise<WebSocketTransport> {
    const headers: Record<string, string> = {};
    if (options.cookie) {
      headers.cookie = options.cookie;
    }
    if (options.origin) {
      headers.origin = options.origin;
    }
    const clientOptions: ClientOptions = {
      headers,
      perMessageDeflate: false,
      rejectUnauthorized: options.rejectUnauthorized,
      maxPayload: options.maxPayloadBytes ?? 128 * 1024 * 1024,
    };
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(options.url, clientOptions);
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        resolve(new WebSocketTransport(socket, options.highWaterMarkBytes ?? 8 * 1024 * 1024));
      });
    });
  }

  public async send(data: Buffer): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("remote WebSocket is not open");
    }
    while (this.socket.bufferedAmount > this.highWaterMark) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.closed) {
        throw new Error("remote WebSocket closed during backpressure wait");
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  }

  public async drain(): Promise<void> {
    while (!this.closed && this.socket.bufferedAmount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  public close(): void {
    if (!this.closed) {
      this.socket.close(1000, "bridge shutdown");
    }
  }

  public terminate(): void {
    this.socket.terminate();
  }

  private toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
      return data;
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data);
    }
    return Buffer.from(data);
  }
}
