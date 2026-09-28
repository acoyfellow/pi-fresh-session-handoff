import type { CheckpointStaleness, FreshSessionCheckpointV1, GitSnapshot } from "./types.js";

export interface StaleCheckInput {
  sessionId: string;
  sequence: number;
  now: Date;
  git: GitSnapshot;
}

export function evaluateCheckpointStaleness(
  checkpoint: FreshSessionCheckpointV1,
  input: StaleCheckInput,
): CheckpointStaleness {
  const reasons: string[] = [];

  if (checkpoint.session.sessionId !== input.sessionId) {
    reasons.push("session-mismatch");
  }

  if (input.sequence > checkpoint.sequence) {
    reasons.push("sequence-advanced");
  }

  if (Date.parse(checkpoint.expiresAt) <= input.now.getTime()) {
    reasons.push("checkpoint-expired");
  }

  if (checkpoint.git.branch !== input.git.branch) {
    reasons.push("git-branch-mismatch");
  }

  if (checkpoint.git.commit !== input.git.commit) {
    reasons.push("git-commit-mismatch");
  }

  if (checkpoint.git.statusDigest !== input.git.statusDigest) {
    reasons.push("git-status-mismatch");
  }

  return {
    stale: reasons.length > 0,
    reasons,
  };
}
