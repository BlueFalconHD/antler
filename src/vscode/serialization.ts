/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See THIRD_PARTY_NOTICES.md in the project root.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code src/vs/base/parts/ipc/common/ipc.ts at
// 8b3775030ed1a69b13e4f4c628c612102e30a681.

const enum DataType {
  Undefined = 0,
  String = 1,
  Buffer = 2,
  VSBuffer = 3,
  Array = 4,
  Object = 5,
  Int = 6,
}

export class VSBufferValue {
  public constructor(public readonly buffer: Buffer) {}
}

export function vsBuffer(buffer: Uint8Array): VSBufferValue {
  return new VSBufferValue(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
}

class Writer {
  private readonly chunks: Buffer[] = [];

  public write(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  public finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class Reader {
  private position = 0;

  public constructor(private readonly input: Buffer) {}

  public read(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.input.length) {
      throw new Error("Malformed VS Code IPC payload");
    }
    const result = this.input.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }
}

function writeVql(writer: Writer, input: number): void {
  let value = input;
  if (value === 0) {
    writer.write(Buffer.from([0]));
    return;
  }
  const bytes: number[] = [];
  while (value !== 0) {
    let next = value & 0x7f;
    value >>>= 7;
    if (value > 0) {
      next |= 0x80;
    }
    bytes.push(next);
  }
  writer.write(Buffer.from(bytes));
}

function readVql(reader: Reader): number {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    const next = reader.read(1)[0];
    if (next === undefined) {
      throw new Error("Malformed VS Code IPC varint");
    }
    value |= (next & 0x7f) << shift;
    if ((next & 0x80) === 0) {
      return value;
    }
  }
  throw new Error("VS Code IPC varint is too long");
}

function writeValue(writer: Writer, data: unknown): void {
  if (data === undefined) {
    writer.write(Buffer.from([DataType.Undefined]));
  } else if (typeof data === "string") {
    const encoded = Buffer.from(data, "utf8");
    writer.write(Buffer.from([DataType.String]));
    writeVql(writer, encoded.length);
    writer.write(encoded);
  } else if (data instanceof VSBufferValue) {
    writer.write(Buffer.from([DataType.VSBuffer]));
    writeVql(writer, data.buffer.length);
    writer.write(data.buffer);
  } else if (Buffer.isBuffer(data)) {
    writer.write(Buffer.from([DataType.Buffer]));
    writeVql(writer, data.length);
    writer.write(data);
  } else if (Array.isArray(data)) {
    writer.write(Buffer.from([DataType.Array]));
    writeVql(writer, data.length);
    for (const item of data) {
      writeValue(writer, item);
    }
  } else if (typeof data === "number" && (data | 0) === data) {
    writer.write(Buffer.from([DataType.Int]));
    writeVql(writer, data);
  } else {
    const encoded = Buffer.from(JSON.stringify(data), "utf8");
    writer.write(Buffer.from([DataType.Object]));
    writeVql(writer, encoded.length);
    writer.write(encoded);
  }
}

export function serialize(...values: readonly unknown[]): Buffer {
  const writer = new Writer();
  for (const value of values) {
    writeValue(writer, value);
  }
  return writer.finish();
}

export function deserialize(reader: Reader): unknown {
  const type = reader.read(1)[0];
  switch (type) {
    case DataType.Undefined:
      return undefined;
    case DataType.String:
      return reader.read(readVql(reader)).toString("utf8");
    case DataType.Buffer:
    case DataType.VSBuffer:
      return reader.read(readVql(reader));
    case DataType.Array: {
      const length = readVql(reader);
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        result.push(deserialize(reader));
      }
      return result;
    }
    case DataType.Object:
      return JSON.parse(reader.read(readVql(reader)).toString("utf8"));
    case DataType.Int:
      return readVql(reader);
    default:
      throw new Error(`Unknown VS Code IPC data type ${String(type)}`);
  }
}
