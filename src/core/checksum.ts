import { createHash } from "node:crypto";

import { canonicalStringify } from "./canonical.js";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function checksumForValue(value: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

export function verifyChecksum(value: unknown, checksum: string): boolean {
  return checksumForValue(value) === checksum;
}
