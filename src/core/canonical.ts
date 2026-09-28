import { stableStringCompare } from "./utils.js";

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function toCanonicalValue(value: unknown): CanonicalValue {
  if (value === null) {
    return null;
  }

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return value as string | boolean;
  }

  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      return String(value) as string;
    }
    return value as number;
  }

  if (kind === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toCanonicalValue(entry));
  }

  if (kind === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, CanonicalValue> = {};
    const keys = Object.keys(input).sort(stableStringCompare);
    for (const key of keys) {
      const next = input[key];
      if (next === undefined) {
        continue;
      }
      output[key] = toCanonicalValue(next);
    }
    return output;
  }

  return String(value);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}
