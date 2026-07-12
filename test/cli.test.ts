import { describe, expect, it } from "vitest";
import { rejectRawPasswordOption, rejectUnexpectedInitArguments } from "../src/cli.js";

describe("CLI password guidance", () => {
  it("rejects an explicit raw password option without repeating the secret", () => {
    const secret = "do-not-print-this";

    expect(() => rejectRawPasswordOption(["bun", "antler", "init", `--password=${secret}`])).toThrow(
      /does not accept raw passwords.*hidden prompt/s,
    );
    try {
      rejectRawPasswordOption(["bun", "antler", "init", `--password=${secret}`]);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("turns an extra positional value into safe password guidance", () => {
    expect(() => rejectUnexpectedInitArguments([".", "raw-password"])).toThrow(
      /Unexpected extra init argument.*does not accept raw passwords/s,
    );
    expect(() => rejectUnexpectedInitArguments(["."])).not.toThrow();
  });
});
