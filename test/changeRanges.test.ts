import { describe, expect, it } from "vitest";
import { ChangeRanges } from "../src/sftp/changeRanges.js";

describe("changed byte ranges", () => {
  it("merges overlapping and adjacent writes in sorted order", () => {
    const changes = new ChangeRanges();
    changes.add(10, 20);
    changes.add(2, 5);
    changes.add(5, 12);
    changes.add(30, 35);
    expect(changes.upTo(100)).toEqual([
      { start: 2, end: 20 },
      { start: 30, end: 35 },
    ]);
  });

  it("clips writes beyond the final truncated size", () => {
    const changes = new ChangeRanges();
    changes.add(2, 8);
    changes.add(12, 20);
    expect(changes.upTo(6)).toEqual([{ start: 2, end: 6 }]);
  });

  it("rejects malformed ranges", () => {
    const changes = new ChangeRanges();
    expect(() => changes.add(-1, 2)).toThrow(/invalid changed byte range/);
    expect(() => changes.upTo(-1)).toThrow(/invalid file size/);
  });
});
