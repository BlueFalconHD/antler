import { describe, expect, it } from "vitest";
import { deserialize, Reader, serialize, vsBuffer } from "../src/vscode/serialization.js";

describe("VS Code IPC serialization", () => {
  it("round-trips request headers and bodies", () => {
    const encoded = serialize([100, 0, "remoteFilesystem", "stat"], [{ scheme: "vscode-remote", path: "/tmp" }]);
    const reader = new Reader(encoded);
    expect(deserialize(reader)).toEqual([100, 0, "remoteFilesystem", "stat"]);
    expect(deserialize(reader)).toEqual([{ scheme: "vscode-remote", path: "/tmp" }]);
  });

  it("uses JSON object encoding for integers outside signed int32", () => {
    const encoded = serialize(2 ** 31);
    expect(encoded[0]).toBe(5);
    expect(deserialize(new Reader(encoded))).toBe(2 ** 31);
  });

  it("matches signed int32 varint behavior", () => {
    const encoded = serialize(-1);
    expect(encoded[0]).toBe(6);
    expect(deserialize(new Reader(encoded))).toBe(-1);
  });

  it("marks file bytes as VSBuffer rather than a native Buffer", () => {
    const encoded = serialize(vsBuffer(Buffer.from([1, 2, 3])));
    expect(encoded[0]).toBe(3);
    expect(deserialize(new Reader(encoded))).toEqual(Buffer.from([1, 2, 3]));
  });
});
