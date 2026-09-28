import type { ContextUsageSnapshot } from "./types.js";
import { nowIso, toFiniteNumber } from "./utils.js";

export function snapshotContextUsage(raw: unknown): ContextUsageSnapshot {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const tokens = toFiniteNumber(source.tokens);
  const percent = toFiniteNumber(source.percent);
  const contextWindow =
    toFiniteNumber(source.contextWindow) ?? toFiniteNumber(source.window) ?? toFiniteNumber(source.maxTokens);

  return {
    tokens,
    percent,
    contextWindow,
    capturedAt: nowIso(),
  };
}
