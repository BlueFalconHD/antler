import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import { closeDispatcher } from "../src/auth/codeServerAuth.js";

describe("HTTP dispatcher cleanup", () => {
  it("closes Node Undici dispatchers", async () => {
    const close = vi.fn();
    await closeDispatcher({ close } as unknown as Dispatcher);
    expect(close).toHaveBeenCalledOnce();
  });

  it("falls back to destroy and accepts Bun's resource-free dispatcher", async () => {
    const destroy = vi.fn();
    await closeDispatcher({ destroy } as unknown as Dispatcher);
    expect(destroy).toHaveBeenCalledOnce();
    await expect(closeDispatcher({} as Dispatcher)).resolves.toBeUndefined();
  });
});
