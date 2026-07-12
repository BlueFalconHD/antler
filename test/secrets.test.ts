import { describe, expect, it } from "vitest";
import { applyMaskedSecretInput } from "../src/secrets.js";

describe("masked secret input", () => {
  it("prints one asterisk per character without exposing the value", () => {
    const result = applyMaskedSecretInput("", "påss");
    expect(result.value).toBe("påss");
    expect(result.maskedOutput).toBe("****");
    expect(result.maskedOutput).not.toContain("påss");
  });

  it("redraws backspace and Ctrl-U erasure", () => {
    expect(applyMaskedSecretInput("abc", "\u007f")).toMatchObject({
      value: "ab",
      maskedOutput: "\b \b",
    });
    expect(applyMaskedSecretInput("abc", "\u0015")).toMatchObject({
      value: "",
      maskedOutput: "\b \b\b \b\b \b",
    });
  });

  it("completes on Enter and cancels on Ctrl-C or Ctrl-D", () => {
    expect(applyMaskedSecretInput("secret", "\r")).toMatchObject({ complete: true, cancelled: false });
    expect(applyMaskedSecretInput("secret", "\u0003")).toMatchObject({ complete: false, cancelled: true });
    expect(applyMaskedSecretInput("secret", "\u0004")).toMatchObject({ complete: false, cancelled: true });
  });
});
