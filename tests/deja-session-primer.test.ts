import { describe, expect, it } from "vitest";
import { buildPrimer, DEFAULT_PRIMER_OPTIONS, hasRecallHits, primerOptionsFrom, primerQuery } from "../src/hooks/deja-session-primer.js";

const HIT = "[medium] 01KYAPNRVAPH9H3R0FJZWDPTXR  kept     2026-07-24T18:37:18  pi/anomalyco [glance]\n  from: cloudflare (folder)\n  Glance prod note";

describe("deja session primer", () => {
  it("queries with the first prompt, collapsed and capped", () => {
    expect(primerQuery("  fix\n\nthe   deploy  ", 400)).toBe("fix the deploy");
    expect(primerQuery("x".repeat(500), 400)).toHaveLength(400);
  });

  it("recognises real hits and ignores empty results", () => {
    expect(hasRecallHits(HIT)).toBe(true);
    expect(hasRecallHits('(no hits for "deploy")')).toBe(false);
  });

  it("returns a primer only when Deja has hits", async () => {
    const primer = await buildPrimer("fix glance", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => HIT);
    expect(primer).toContain("Deja memory");
    expect(primer).toContain("kind=used");
    expect(primer).toContain("Glance prod note");
    expect(await buildPrimer("fix glance", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => "(no hits)")).toBeUndefined();
    expect(await buildPrimer("   ", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => HIT)).toBeUndefined();
  });

  it("never breaks the turn when Deja fails", async () => {
    const primer = await buildPrimer("fix glance", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => {
      throw new Error("deja missing");
    });
    expect(primer).toBeUndefined();
  });

  it("reads options with safe fallbacks", () => {
    expect(primerOptionsFrom({ dejaCommand: ["bun", "cli.ts"], maxTokens: 300 })).toMatchObject({ dejaCommand: ["bun", "cli.ts"], maxTokens: 300, timeoutMs: 4000 });
    expect(primerOptionsFrom({ dejaCommand: [], maxTokens: -1 })).toMatchObject({ dejaCommand: ["deja"], maxTokens: 600 });
  });
});
