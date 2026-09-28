import { CHECKPOINT_PROTOCOL, CHECKPOINT_SCHEMA_VERSION } from "./constants.js";
import type { FreshSessionCheckpointV1 } from "./types.js";

export function validateCheckpointSchema(checkpoint: FreshSessionCheckpointV1): string[] {
  const errors: string[] = [];

  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    errors.push("schemaVersion");
  }
  if (checkpoint.protocol !== CHECKPOINT_PROTOCOL) {
    errors.push("protocol");
  }
  if (!checkpoint.checkpointId) {
    errors.push("checkpointId");
  }
  if (!checkpoint.checksum.startsWith("sha256:")) {
    errors.push("checksum");
  }
  if (!checkpoint.session.sessionId) {
    errors.push("session.sessionId");
  }
  if (!checkpoint.model.provider || !checkpoint.model.id || !checkpoint.model.route) {
    errors.push("model");
  }
  if (!checkpoint.taskManifest.manifestVersion || !checkpoint.taskManifest.taskId) {
    errors.push("taskManifest");
  }
  if (!checkpoint.criticalFacts.testCommand || !checkpoint.criticalFacts.finalProofCommand) {
    errors.push("criticalFacts.commands");
  }
  if (!checkpoint.criticalFacts.untrustedInstructionDataDigest) {
    errors.push("criticalFacts.untrustedInstructionDataDigest");
  }
  if (!Array.isArray(checkpoint.git.status) || !Array.isArray(checkpoint.git.untracked)) {
    errors.push("git.status");
  }
  if (!Array.isArray(checkpoint.untrustedInstructionData)) {
    errors.push("untrustedInstructionData");
  }

  return errors;
}
