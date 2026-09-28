import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export async function ensureDirectory(pathValue: string): Promise<void> {
  await mkdir(pathValue, { recursive: true });
}

export function clampPositiveInteger(value: number, fallback: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function newLeaseId(): string {
  return randomUUID();
}

export function stableStringCompare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort(stableStringCompare);
}

export function isSubPath(basePath: string, candidatePath: string): boolean {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
