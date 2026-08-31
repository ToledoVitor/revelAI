import { Buffer } from "node:buffer";
import { vi } from "vitest";

const randomBytes = vi.hoisted(() =>
  vi.fn((size: number) => Buffer.alloc(size, 0xff)),
);

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes,
}));

import { describe, expect, it } from "vitest";
import { createAes256GcmNonceAllocator } from "./cursor-nonce-allocator.js";

describe("AES-256-GCM cursor nonce allocator", () => {
  it("fails before it can reuse the final 96-bit nonce", () => {
    const allocator = createAes256GcmNonceAllocator();

    expect(allocator.next()).toEqual(Buffer.alloc(12, 0xff));
    expect(() => allocator.next()).toThrow("cursor nonce counter exhausted");
  });
});
