import { LAUNCH_ENTRY_TYPE } from "./constants.js";
import type { CheckpointCriticalFacts } from "./types.js";

export interface LaunchMarker {
  checkpointId: string;
  checksum: string;
  leaseId: string | null;
  criticalFacts: CheckpointCriticalFacts;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseFacts(value: unknown): CheckpointCriticalFacts {
  const source = asRecord(value);
  return {
    manifestVersion: typeof source.manifestVersion === "string" ? source.manifestVersion : "",
    taskId: typeof source.taskId === "string" ? source.taskId : "",
    requiredModelProvider:
      typeof source.requiredModelProvider === "string" ? source.requiredModelProvider : "",
    requiredModelId: typeof source.requiredModelId === "string" ? source.requiredModelId : "",
    requiredModelRoute: typeof source.requiredModelRoute === "string" ? source.requiredModelRoute : "",
    branch: typeof source.branch === "string" ? source.branch : null,
    commit: typeof source.commit === "string" ? source.commit : null,
    statusDigest: typeof source.statusDigest === "string" ? source.statusDigest : "",
    sequence: typeof source.sequence === "number" ? source.sequence : 0,
    testCommand: typeof source.testCommand === "string" ? source.testCommand : "",
    finalProofCommand: typeof source.finalProofCommand === "string" ? source.finalProofCommand : "",
    protectedPathsDigest: typeof source.protectedPathsDigest === "string" ? source.protectedPathsDigest : "",
    forbiddenModelsDigest: typeof source.forbiddenModelsDigest === "string" ? source.forbiddenModelsDigest : "",
    semanticFactsDigest: typeof source.semanticFactsDigest === "string" ? source.semanticFactsDigest : "",
    untrustedInstructionPathsDigest:
      typeof source.untrustedInstructionPathsDigest === "string" ? source.untrustedInstructionPathsDigest : "",
    untrustedInstructionDataDigest:
      typeof source.untrustedInstructionDataDigest === "string" ? source.untrustedInstructionDataDigest : "",
  };
}

export function findLatestLaunchMarker(entries: unknown[]): LaunchMarker | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    if (entry.type !== "custom" || entry.customType !== LAUNCH_ENTRY_TYPE) {
      continue;
    }
    const data = asRecord(entry.data);
    const checkpointId = typeof data.checkpointId === "string" ? data.checkpointId : "";
    const checksum = typeof data.checksum === "string" ? data.checksum : "";
    if (!checkpointId || !checksum) {
      continue;
    }

    return {
      checkpointId,
      checksum,
      leaseId: typeof data.leaseId === "string" ? data.leaseId : null,
      criticalFacts: parseFacts(data.criticalFacts),
    };
  }

  return null;
}
