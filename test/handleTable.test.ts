import { describe, expect, it } from "vitest";
import { HandleTable } from "../src/sftp/handleTable.js";

describe("SFTP handle table", () => {
  it("supports concurrent opaque handles and cleanup", () => {
    const table = new HandleTable();
    const first = table.add({ kind: "directory", generation: 1, path: "/a", entries: [], index: 0 });
    const second = table.add({ kind: "directory", generation: 1, path: "/b", entries: [], index: 0 });
    expect(first.equals(second)).toBe(false);
    expect(table.get(first)).toMatchObject({ path: "/a" });
    expect(table.take(first)).toMatchObject({ path: "/a" });
    expect(table.get(first)).toBeUndefined();
    expect(table.values()).toHaveLength(1);
    table.clear();
    expect(table.values()).toHaveLength(0);
  });
});
