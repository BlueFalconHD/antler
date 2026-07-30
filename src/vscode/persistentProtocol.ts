/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See THIRD_PARTY_NOTICES.md in the project root.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code src/vs/base/parts/ipc/common/ipc.net.ts at
// 93cfdd489c3b228840d0f86ec77c3636277c93ea.

import { EventEmitter } from "node:events";

export interface ProtocolTransport extends EventEmitter {
  send(data: Buffer): Promise<void>;
  drain(): Promise<void>;
  close(): void;
  terminate(): void;
}

export const enum ProtocolMessageType {
  Regular = 1,
  Control = 2,
  Ack = 3,
  Disconnect = 5,
  ReplayRequest = 6,
  Pause = 7,
  Resume = 8,
  KeepAlive = 9,
}

interface ProtocolFrame {
  readonly type: ProtocolMessageType;
  readonly id: number;
  readonly ack: number;
  readonly data: Buffer;
}

interface PendingWrite {
  readonly encoded: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const HEADER_LENGTH = 13;
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

function encodeFrame(frame: ProtocolFrame): Buffer {
  const header = Buffer.allocUnsafe(HEADER_LENGTH);
  header.writeUInt8(frame.type, 0);
  header.writeUInt32BE(frame.id, 1);
  header.writeUInt32BE(frame.ack, 5);
  header.writeUInt32BE(frame.data.length, 9);
  return Buffer.concat([header, frame.data], HEADER_LENGTH + frame.data.length);
}

export class PersistentProtocol extends EventEmitter {
  private input: Buffer = Buffer.alloc(0);
  private outgoingId = 0;
  private outgoingAck = 0;
  private incomingId = 0;
  private incomingAck = 0;
  private readonly unacknowledged = new Map<number, Buffer>();
  private writeChain: Promise<void> = Promise.resolve();
  private paused = false;
  private readonly pendingWrites: PendingWrite[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private ackTimer: NodeJS.Timeout | undefined;
  private readonly keepAliveTimer: NodeJS.Timeout;
  private disposed = false;

  public constructor(private readonly transport: ProtocolTransport) {
    super();
    transport.on("data", (chunk: Buffer) => this.accept(chunk));
    transport.on("close", (error: Error) => this.handleClose(error));
    transport.on("transportError", (error: Error) => this.handleClose(error));
    this.keepAliveTimer = setInterval(() => {
      void this.queueFrame({
        type: ProtocolMessageType.KeepAlive,
        id: 0,
        ack: this.incomingId,
        data: Buffer.alloc(0),
      }).catch(() => undefined);
    }, 5_000);
  }

  public async sendControl(data: Buffer): Promise<void> {
    await this.queueFrame({ type: ProtocolMessageType.Control, id: 0, ack: 0, data });
  }

  public async sendRegular(data: Buffer): Promise<void> {
    const id = ++this.outgoingId;
    this.incomingAck = this.incomingId;
    const encoded = encodeFrame({
      type: ProtocolMessageType.Regular,
      id,
      ack: this.incomingAck,
      data,
    });
    this.unacknowledged.set(id, encoded);
    await this.queueEncoded(encoded);
  }

  public async disconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.queueFrame({
      type: ProtocolMessageType.Disconnect,
      id: 0,
      ack: 0,
      data: Buffer.alloc(0),
    });
    await this.drain();
    this.dispose();
    this.transport.close();
  }

  public async drain(): Promise<void> {
    this.flushPendingWrites();
    await this.writeChain;
    await this.transport.drain();
  }

  public dispose(error = new Error("remote protocol is closed")): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.keepAliveTimer);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
    }
    for (const pending of this.pendingWrites.splice(0)) {
      pending.reject(error);
    }
    this.removeAllListeners();
  }

  private accept(chunk: Buffer): void {
    this.input = this.input.length === 0 ? Buffer.concat([chunk]) : Buffer.concat([this.input, chunk]);
    while (this.input.length >= HEADER_LENGTH) {
      const length = this.input.readUInt32BE(9);
      if (length > MAX_FRAME_BYTES) {
        this.handleClose(new Error(`remote protocol frame exceeds ${MAX_FRAME_BYTES} bytes`));
        this.transport.terminate();
        return;
      }
      if (this.input.length < HEADER_LENGTH + length) {
        return;
      }
      const frame: ProtocolFrame = {
        type: this.input.readUInt8(0) as ProtocolMessageType,
        id: this.input.readUInt32BE(1),
        ack: this.input.readUInt32BE(5),
        data: this.input.subarray(HEADER_LENGTH, HEADER_LENGTH + length),
      };
      this.input = this.input.subarray(HEADER_LENGTH + length);
      this.receive(frame);
    }
  }

  private receive(frame: ProtocolFrame): void {
    if (frame.ack > this.outgoingAck) {
      this.outgoingAck = frame.ack;
      for (const id of this.unacknowledged.keys()) {
        if (id <= frame.ack) {
          this.unacknowledged.delete(id);
        }
      }
    }

    switch (frame.type) {
      case ProtocolMessageType.Regular:
        if (frame.id === this.incomingId + 1) {
          this.incomingId = frame.id;
          this.scheduleAck();
          this.emit("message", frame.data);
        } else if (frame.id > this.incomingId + 1) {
          void this.queueFrame({
            type: ProtocolMessageType.ReplayRequest,
            id: 0,
            ack: 0,
            data: Buffer.alloc(0),
          }).catch(() => undefined);
        }
        break;
      case ProtocolMessageType.Control:
        this.emit("control", frame.data);
        break;
      case ProtocolMessageType.ReplayRequest:
        for (const encoded of this.unacknowledged.values()) {
          void this.queueEncoded(encoded).catch(() => undefined);
        }
        break;
      case ProtocolMessageType.Pause:
        this.paused = true;
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = undefined;
        }
        break;
      case ProtocolMessageType.Resume:
        this.paused = false;
        this.scheduleFlush();
        break;
      case ProtocolMessageType.Disconnect:
        this.handleClose(new Error("remote protocol disconnected"));
        break;
      case ProtocolMessageType.Ack:
      case ProtocolMessageType.KeepAlive:
        break;
      default:
        this.handleClose(new Error(`unsupported remote protocol message type ${frame.type}`));
    }
  }

  private scheduleAck(): void {
    if (this.incomingId <= this.incomingAck || this.ackTimer) {
      return;
    }
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      this.incomingAck = this.incomingId;
      void this.queueFrame({
        type: ProtocolMessageType.Ack,
        id: 0,
        ack: this.incomingAck,
        data: Buffer.alloc(0),
      }).catch(() => undefined);
    }, 2_000);
  }

  private queueFrame(frame: ProtocolFrame): Promise<void> {
    return this.queueEncoded(encodeFrame(frame));
  }

  private queueEncoded(encoded: Buffer): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("remote protocol is closed"));
    }
    const queued = new Promise<void>((resolve, reject) => {
      this.pendingWrites.push({ encoded, resolve, reject });
    });
    this.scheduleFlush();
    return queued;
  }

  private scheduleFlush(): void {
    if (this.disposed || this.paused || this.flushTimer || this.pendingWrites.length === 0) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPendingWrites();
    });
  }

  private flushPendingWrites(): void {
    if (this.disposed || this.paused || this.pendingWrites.length === 0) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    let batchBytes = 0;
    let batchLength = 0;
    for (const entry of this.pendingWrites) {
      if (batchLength > 0 && batchBytes + entry.encoded.length > MAX_BATCH_BYTES) break;
      batchBytes += entry.encoded.length;
      batchLength += 1;
    }
    const pending = this.pendingWrites.splice(0, batchLength);
    const encoded = Buffer.concat(pending.map((entry) => entry.encoded), batchBytes);
    const write = this.writeChain.then(() => this.transport.send(encoded));
    write.then(
      () => {
        for (const entry of pending) entry.resolve();
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const entry of pending) entry.reject(failure);
      },
    );
    this.writeChain = write.catch((error: unknown) => {
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
    });
    this.scheduleFlush();
  }

  private handleClose(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.emit("close", error);
    this.dispose(error);
  }
}
