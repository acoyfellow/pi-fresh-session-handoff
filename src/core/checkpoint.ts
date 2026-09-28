import {
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_SCHEMA_VERSION,
  EXTENSION_NAME,
  EXTENSION_VERSION,
} from "./constants.js";
import { checksumForValue } from "./checksum.js";
import { sortUnique, stableStringCompare } from "./utils.js";
import type {
  CheckpointCriticalFacts,
  CommandRunMetadata,
  ContextUsageSnapshot,
  FreshSessionCheckpointV1,
  GitSnapshot,
  ModelSnapshot,
  RedactionReport,
  TaskManifestV1,
  UntrustedInstructionSnapshot,
} from "./types.js";

export interface CreateCheckpointInput {
  sessionId: string;
  sessionFile: string | null;
  leafId: string | null;
  parentSession: string | null;
  sequence: number;
  createdAt: string;
  expiresAt: string;
  usage: ContextUsageSnapshot;
  model: ModelSnapshot;
  git: GitSnapshot;
  taskManifest: TaskManifestV1;
  untrustedInstructionData: UntrustedInstructionSnapshot[];
  commandMetadata: CommandRunMetadata[];
  redaction: RedactionReport;
  machine: string;
  extensionVersion?: string;
}

export function buildCheckpointId(sessionId: string, leafId: string | null, sequence: number): string {
  const leaf = leafId ?? "leaf-root";
  return `${sessionId}:${leaf}:${sequence}`;
}

function normalizeSemanticFacts(facts: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  const keys = Object.keys(facts).sort(stableStringCompare);
  for (const key of keys) {
    output[key] = facts[key] ?? "";
  }
  return output;
}

function normalizeUntrustedInstructionData(
  entries: UntrustedInstructionSnapshot[],
): UntrustedInstructionSnapshot[] {
  return [...entries]
    .map((entry) => ({
      path: entry.path,
      exists: Boolean(entry.exists),
      checksum: typeof entry.checksum === "string" ? entry.checksum : null,
      bytes: typeof entry.bytes === "number" ? entry.bytes : null,
    }))
    .sort((a, b) => stableStringCompare(a.path, b.path));
}

export function buildCriticalFacts(
  manifest: TaskManifestV1,
  model: ModelSnapshot,
  git: GitSnapshot,
  sequence: number,
  untrustedInstructionData: UntrustedInstructionSnapshot[],
): CheckpointCriticalFacts {
  const normalizedUntrustedInstructionData = normalizeUntrustedInstructionData(untrustedInstructionData);

  return {
    manifestVersion: manifest.manifestVersion,
    taskId: manifest.taskId,
    requiredModelProvider: model.provider,
    requiredModelId: model.id,
    requiredModelRoute: model.route,
    branch: git.branch,
    commit: git.commit,
    statusDigest: git.statusDigest,
    sequence,
    testCommand: manifest.testCommand,
    finalProofCommand: manifest.finalProofCommand,
    protectedPathsDigest: checksumForValue({ protectedPaths: sortUnique(manifest.protectedPaths) }),
    forbiddenModelsDigest: checksumForValue({ forbiddenModels: sortUnique(manifest.forbiddenModels) }),
    semanticFactsDigest: checksumForValue({ semanticFacts: normalizeSemanticFacts(manifest.semanticFacts) }),
    untrustedInstructionPathsDigest: checksumForValue({
      untrustedInstructionPaths: sortUnique(manifest.untrustedInstructionPaths),
    }),
    untrustedInstructionDataDigest: checksumForValue({
      untrustedInstructionData: normalizedUntrustedInstructionData,
    }),
  };
}

function checksumPayload(checkpoint: FreshSessionCheckpointV1): Omit<FreshSessionCheckpointV1, "checksum"> {
  const { checksum: _checksum, ...rest } = checkpoint;
  return rest;
}

function latestRunByKind(entries: CommandRunMetadata[], kind: "test" | "proof"): CommandRunMetadata | null {
  const filtered = entries
    .filter((entry) => entry.kind === kind)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  return filtered[0] ?? null;
}

export function createCheckpoint(input: CreateCheckpointInput): FreshSessionCheckpointV1 {
  const checkpointId = buildCheckpointId(input.sessionId, input.leafId, input.sequence);
  const untrustedInstructionData = normalizeUntrustedInstructionData(input.untrustedInstructionData);
  const criticalFacts = buildCriticalFacts(
    input.taskManifest,
    input.model,
    input.git,
    input.sequence,
    untrustedInstructionData,
  );

  const checkpoint: FreshSessionCheckpointV1 = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    protocol: CHECKPOINT_PROTOCOL,
    checkpointId,
    sequence: input.sequence,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    checksum: "sha256:pending",
    source: {
      extension: EXTENSION_NAME,
      extensionVersion: input.extensionVersion ?? EXTENSION_VERSION,
      machine: input.machine,
    },
    session: {
      sessionId: input.sessionId,
      sessionFile: input.sessionFile,
      leafId: input.leafId,
      parentSession: input.parentSession,
    },
    usage: input.usage,
    model: input.model,
    git: input.git,
    taskManifest: input.taskManifest,
    semanticTaskFacts: input.taskManifest.semanticFacts,
    untrustedInstructionData,
    commandMetadata: input.commandMetadata,
    testMetadata: {
      command: input.taskManifest.testCommand,
      finalProofCommand: input.taskManifest.finalProofCommand,
      lastTestRun: latestRunByKind(input.commandMetadata, "test"),
      lastProofRun: latestRunByKind(input.commandMetadata, "proof"),
    },
    redaction: input.redaction,
    criticalFacts,
  };

  checkpoint.checksum = checksumForValue(checksumPayload(checkpoint));
  return checkpoint;
}

export function verifyCheckpointChecksum(checkpoint: FreshSessionCheckpointV1): boolean {
  return checksumForValue(checksumPayload(checkpoint)) === checkpoint.checksum;
}
