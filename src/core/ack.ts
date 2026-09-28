import { buildCriticalFacts } from "./checkpoint.js";
import type {
  AckChallengePayload,
  CheckpointCriticalFacts,
  FreshSessionCheckpointV1,
  GitSnapshot,
  ModelSnapshot,
  TaskManifestV1,
  UntrustedInstructionSnapshot,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

export function parseAckPayload(raw: string): AckChallengePayload {
  const parsed = JSON.parse(raw) as unknown;
  const root = asRecord(parsed);
  const factsInput = asRecord(root.facts);

  const facts: CheckpointCriticalFacts = {
    manifestVersion: asString(factsInput.manifestVersion),
    taskId: asString(factsInput.taskId),
    requiredModelProvider: asString(factsInput.requiredModelProvider),
    requiredModelId: asString(factsInput.requiredModelId),
    requiredModelRoute: asString(factsInput.requiredModelRoute),
    branch: asNullableString(factsInput.branch),
    commit: asNullableString(factsInput.commit),
    statusDigest: asString(factsInput.statusDigest),
    sequence: Number(factsInput.sequence) || 0,
    testCommand: asString(factsInput.testCommand),
    finalProofCommand: asString(factsInput.finalProofCommand),
    protectedPathsDigest: asString(factsInput.protectedPathsDigest),
    forbiddenModelsDigest: asString(factsInput.forbiddenModelsDigest),
    semanticFactsDigest: asString(factsInput.semanticFactsDigest),
    untrustedInstructionPathsDigest: asString(factsInput.untrustedInstructionPathsDigest),
    untrustedInstructionDataDigest: asString(factsInput.untrustedInstructionDataDigest),
  };

  return {
    checkpointId: asString(root.checkpointId),
    checksum: asString(root.checksum),
    targetSessionId: asString(root.targetSessionId),
    leaseId: asString(root.leaseId),
    facts,
  };
}

export function buildAckTemplate(
  checkpoint: FreshSessionCheckpointV1,
  targetSessionId: string,
  leaseId: string,
): string {
  const payload: AckChallengePayload = {
    checkpointId: checkpoint.checkpointId,
    checksum: checkpoint.checksum,
    targetSessionId,
    leaseId,
    facts: checkpoint.criticalFacts,
  };

  return JSON.stringify(payload);
}

function compareFacts(a: CheckpointCriticalFacts, b: CheckpointCriticalFacts): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(a) as Array<keyof CheckpointCriticalFacts>) {
    if (a[key] !== b[key]) {
      mismatches.push(`facts.${String(key)}`);
    }
  }
  return mismatches;
}

export function buildRuntimeFacts(input: {
  checkpoint: FreshSessionCheckpointV1;
  model: ModelSnapshot;
  git: GitSnapshot;
  manifest: TaskManifestV1;
  untrustedInstructionData: UntrustedInstructionSnapshot[];
}): CheckpointCriticalFacts {
  return buildCriticalFacts(
    input.manifest,
    input.model,
    input.git,
    input.checkpoint.sequence,
    input.untrustedInstructionData,
  );
}

export interface AckValidationResult {
  ok: boolean;
  errors: string[];
}

export interface AckBinding {
  checkpointId: string;
  checksum: string;
  targetSessionId: string;
  leaseId: string;
}

export function validateAckPayload(
  checkpoint: FreshSessionCheckpointV1,
  payload: AckChallengePayload,
  runtimeFacts: CheckpointCriticalFacts,
  binding: AckBinding,
): AckValidationResult {
  const errors: string[] = [];

  if (payload.checkpointId !== checkpoint.checkpointId || payload.checkpointId !== binding.checkpointId) {
    errors.push("checkpointId-mismatch");
  }
  if (payload.checksum !== checkpoint.checksum || payload.checksum !== binding.checksum) {
    errors.push("checksum-mismatch");
  }
  if (payload.targetSessionId !== binding.targetSessionId) {
    errors.push("targetSessionId-mismatch");
  }
  if (payload.leaseId !== binding.leaseId) {
    errors.push("leaseId-mismatch");
  }

  errors.push(...compareFacts(checkpoint.criticalFacts, payload.facts));
  errors.push(...compareFacts(checkpoint.criticalFacts, runtimeFacts).map((value) => `runtime-${value}`));

  return {
    ok: errors.length === 0,
    errors,
  };
}
