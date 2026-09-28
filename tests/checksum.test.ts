import { describe, expect, it } from "vitest";

import { canonicalStringify } from "../src/core/canonical.js";
import { checksumForValue } from "../src/core/checksum.js";

describe("canonical checksums", () => {
  it("canonicalizes object key order", () => {
    const a = { b: 2, a: 1, nested: { z: 9, y: 8 } };
    const b = { nested: { y: 8, z: 9 }, a: 1, b: 2 };

    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(checksumForValue(a)).toBe(checksumForValue(b));
  });

  it("uses deterministic locale-independent ordering", () => {
    const payload = { ä: 1, z: 2 };
    expect(canonicalStringify(payload)).toBe('{"z":2,"ä":1}');
  });

  it("changes checksum when payload changes", () => {
    const baseline = { a: 1, b: 2 };
    const changed = { a: 1, b: 3 };

    expect(checksumForValue(baseline)).not.toBe(checksumForValue(changed));
  });
});
