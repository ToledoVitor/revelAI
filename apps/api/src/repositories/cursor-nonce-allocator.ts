import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

const AES_256_GCM_NONCE_BYTES = 12;
const MAX_AES_256_GCM_NONCE = (1n << 96n) - 1n;

export type Aes256GcmNonceAllocator = Readonly<{
  next(): Buffer;
}>;

/**
 * Allocates non-repeating AES-GCM nonces without retaining a history. The
 * counter makes every allocation in one process distinct; default cursor keys
 * are separately random for each process.
 */
export function createAes256GcmNonceAllocator(): Aes256GcmNonceAllocator {
  let nextCounter = BigInt(
    `0x${randomBytes(AES_256_GCM_NONCE_BYTES).toString("hex")}`,
  );

  return Object.freeze({
    next(): Buffer {
      if (nextCounter > MAX_AES_256_GCM_NONCE)
        throw new Error("AES-256-GCM cursor nonce counter exhausted.");
      const nonce = Buffer.from(
        nextCounter.toString(16).padStart(24, "0"),
        "hex",
      );
      nextCounter += 1n;
      return nonce;
    },
  });
}
