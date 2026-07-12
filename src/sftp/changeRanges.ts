export interface ChangeRange {
  readonly start: number;
  readonly end: number;
}

export class ChangeRanges {
  private ranges: ChangeRange[] = [];

  public add(start: number, end: number): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error("invalid changed byte range");
    }
    if (start === end) {
      return;
    }

    const merged: ChangeRange[] = [];
    let candidate = { start, end };
    let inserted = false;
    for (const current of this.ranges) {
      if (current.end < candidate.start) {
        merged.push(current);
      } else if (candidate.end < current.start) {
        if (!inserted) {
          merged.push(candidate);
          inserted = true;
        }
        merged.push(current);
      } else {
        candidate = {
          start: Math.min(candidate.start, current.start),
          end: Math.max(candidate.end, current.end),
        };
      }
    }
    if (!inserted) {
      merged.push(candidate);
    }
    this.ranges = merged;
  }

  public upTo(size: number): ChangeRange[] {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid file size");
    }
    return this.ranges
      .filter((range) => range.start < size)
      .map((range) => ({ start: range.start, end: Math.min(range.end, size) }));
  }
}
