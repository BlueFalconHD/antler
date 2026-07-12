import { EventEmitter, once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  PersistentProtocol,
  ProtocolMessageType,
  type ProtocolTransport,
} from "../src/vscode/persistentProtocol.js";

class FakeTransport extends EventEmitter implements ProtocolTransport {
  public readonly writes: Buffer[] = [];
  public closed = false;

  public async send(data: Buffer): Promise<void> {
    this.writes.push(Buffer.from(data));
  }

  public async drain(): Promise<void> {}
  public close(): void {
    this.closed = true;
  }
  public terminate(): void {
    this.closed = true;
  }
}

function frame(type: number, id: number, ack: number, body: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(ack, 5);
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body]);
}

describe("persistent remote-agent framing", () => {
  it("writes the authoritative 13-byte header", async () => {
    const transport = new FakeTransport();
    const protocol = new PersistentProtocol(transport);
    await protocol.sendRegular(Buffer.from("hello"));
    expect(transport.writes[0]?.length).toBe(18);
    expect(transport.writes[0]?.readUInt8(0)).toBe(ProtocolMessageType.Regular);
    expect(transport.writes[0]?.readUInt32BE(1)).toBe(1);
    expect(transport.writes[0]?.readUInt32BE(9)).toBe(5);
    protocol.dispose();
  });

  it("coalesces same-tick frames like VS Code's protocol writer", async () => {
    const transport = new FakeTransport();
    const protocol = new PersistentProtocol(transport);

    await Promise.all([
      protocol.sendRegular(Buffer.from("one")),
      protocol.sendRegular(Buffer.from("two")),
      protocol.sendRegular(Buffer.from("three")),
    ]);

    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0]).toEqual(Buffer.concat([
      frame(ProtocolMessageType.Regular, 1, 0, Buffer.from("one")),
      frame(ProtocolMessageType.Regular, 2, 0, Buffer.from("two")),
      frame(ProtocolMessageType.Regular, 3, 0, Buffer.from("three")),
    ]));
    protocol.dispose();
  });

  it("parses a frame split across arbitrary WebSocket chunks", async () => {
    const transport = new FakeTransport();
    const protocol = new PersistentProtocol(transport);
    const received = once(protocol, "message");
    const encoded = frame(ProtocolMessageType.Regular, 1, 0, Buffer.from("payload"));
    transport.emit("data", encoded.subarray(0, 4));
    transport.emit("data", encoded.subarray(4, 15));
    transport.emit("data", encoded.subarray(15));
    const [message] = await received;
    expect(message).toEqual(Buffer.from("payload"));
    protocol.dispose();
  });

  it("parses multiple frames coalesced into one WebSocket message", async () => {
    const transport = new FakeTransport();
    const protocol = new PersistentProtocol(transport);
    const messages: string[] = [];
    protocol.on("message", (message: Buffer) => messages.push(message.toString()));
    transport.emit(
      "data",
      Buffer.concat([
        frame(ProtocolMessageType.Regular, 1, 0, Buffer.from("one")),
        frame(ProtocolMessageType.Regular, 2, 0, Buffer.from("two")),
      ]),
    );
    expect(messages).toEqual(["one", "two"]);
    protocol.dispose();
  });
});
