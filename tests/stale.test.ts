import { describe, expect, it } from "vitest";

import { evaluateCheckpointStaleness } from "../src/core/stale.js";
import { sampleCheckpoint, sampleGit } from "./helpers.js";

describe("checkpoint stale detection", () => {
  it("passes when runtime matches checkpoint", () => {
    const checkpoint = sampleCheckpoint();
    const result = evaluateCheckpointStaleness(checkpoint, {
      sessionId: checkpoint.session.sessionId,
      sequence: checkpoint.sequence,
      now: new Date("2026-01-01T00:30:00.000Z"),
      git: checkpoint.git,
    });

    expect(result.stale).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("detects session, git, sequence, and expiry mismatches", () => {
    const checkpoint = sampleCheckpoint({ expiresAt: "2026-01-01T00:10:00.000Z" });
    const mismatchedGit = sampleGit({
      branch: "feature/new",
      commit: "different",
      statusDigest: "sha256:other",
    });

    const result = evaluateCheckpointStaleness(checkpoint, {
      sessionId: "other-session",
      sequence: checkpoint.sequence + 1,
      now: new Date("2026-01-01T01:00:00.000Z"),
      git: mismatchedGit,
    });

    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("session-mismatch");
    expect(result.reasons).toContain("sequence-advanced");
    expect(result.reasons).toContain("checkpoint-expired");
    expect(result.reasons).toContain("git-branch-mismatch");
    expect(result.reasons).toContain("git-commit-mismatch");
    expect(result.reasons).toContain("git-status-mismatch");
  });
});
