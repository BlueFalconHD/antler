import { describe, expect, it, vi } from "vitest";
import { TransferProgressReporter } from "../src/transferProgress.js";

describe("large transfer progress", () => {
  it("prints a throttled byte-accurate bar and leaves completion to the success event", () => {
    const info = vi.fn();
    const reporter = new TransferProgressReporter({ info }, 100);
    const base = { direction: "upload" as const, path: "data/large.bin", totalBytes: 1_000 };

    reporter.report({ ...base, transferredBytes: 0 });
    reporter.report({ ...base, transferredBytes: 50 });
    reporter.report({ ...base, transferredBytes: 100 });
    reporter.report({ ...base, transferredBytes: 190 });
    reporter.report({ ...base, transferredBytes: 550 });
    reporter.report({ ...base, transferredBytes: 1_000 });

    expect(info).toHaveBeenCalledTimes(3);
    expect(info.mock.calls[0]?.[0]).toContain("↑ Sending data/large.bin [░░░░░░░░░░░░░░░░] 0%");
    expect(info.mock.calls[1]?.[0]).toContain("10%");
    expect(info.mock.calls[2]?.[0]).toContain("55%");
    expect(info.mock.calls[2]?.[1]).toEqual({ transferred: "550 B", total: "1000 B" });
  });

  it("does not add progress noise for small files", () => {
    const info = vi.fn();
    const reporter = new TransferProgressReporter({ info }, 100);
    reporter.report({
      direction: "download",
      path: "small.txt",
      transferredBytes: 99,
      totalBytes: 99,
    });
    expect(info).not.toHaveBeenCalled();
  });
});
