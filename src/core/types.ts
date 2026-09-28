export type ThresholdStage = "below" | "warning" | "prepare" | "force";

export interface ThresholdConfig {
  warningPercent: number;
  preparePercent: number;
  forcePercent: number;
  warningTokens: number;
  prepareTokens: number;
  forceTokens: number;
}

export interface ContextUsageSnapshot {
  tokens: number | null;
  percent: number | null;
  contextWindow: number | null;
  capturedAt: string;
}

export interface ModelSnapshot {
  provider: string;
  id: string;
  route: string;
  displayName: string;
}

export interface GitSnapshot {
  cwd: string;
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  status: string[];
  untracked: string[];
  statusDigest: string;
  dirty: boolean;
}

export type CommandKind = "git" | "test" | "proof" | "launcher" | "state" | "other";

export interface CommandRunMetadata {
  command: string;
  kind: CommandKind;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
}

export interface RequiredModel {
  provider: string;
  id: string;
  route?: string;
}

export interface TaskManifestV1 {
  manifestVersion: "1";
  taskId: string;
  title: string;
  summary: string;
  requiredModel?: RequiredModel;
  semanticFacts: Record<string, string>;
  protectedPaths: string[];
  testCommand: string;
  finalProofCommand: string;
  forbiddenModels: string[];
  untrustedInstructionPaths: string[];
  expiresMinutes: number;
}

export interface RedactionReport {
  removedEnvKeys: string[];
  keptEnvKeys: string[];
  transcriptStored: false;
  toolOutputsStored: false;
  assistantReasoningStored: false;
}

export interface CheckpointCriticalFacts {
  manifestVersion: string;
  taskId: string;
  requiredModelProvider: string;
  requiredModelId: string;
  requiredModelRoute: string;
  branch: string | null;
  commit: string | null;
  statusDigest: string;
  sequence: number;
  testCommand: string;
  finalProofCommand: string;
  protectedPathsDigest: string;
  forbiddenModelsDigest: string;
  semanticFactsDigest: string;
  untrustedInstructionPathsDigest: string;
  untrustedInstructionDataDigest: string;
}

export interface UntrustedInstructionSnapshot {
  path: string;
  exists: boolean;
  checksum: string | null;
  bytes: number | null;
}

export interface FreshSessionCheckpointV1 {
  schemaVersion: "1";
  protocol: "fresh-session-handoff";
  checkpointId: string;
  sequence: number;
  createdAt: string;
  expiresAt: string;
  checksum: string;
  source: {
    extension: string;
    extensionVersion: string;
    machine: string;
  };
  session: {
    sessionId: string;
    sessionFile: string | null;
    leafId: string | null;
    parentSession: string | null;
  };
  usage: ContextUsageSnapshot;
  model: ModelSnapshot;
  git: GitSnapshot;
  taskManifest: TaskManifestV1;
  semanticTaskFacts: Record<string, string>;
  untrustedInstructionData: UntrustedInstructionSnapshot[];
  commandMetadata: CommandRunMetadata[];
  testMetadata: {
    command: string;
    finalProofCommand: string;
    lastTestRun: CommandRunMetadata | null;
    lastProofRun: CommandRunMetadata | null;
  };
  redaction: RedactionReport;
  criticalFacts: CheckpointCriticalFacts;
}

export type LaunchStatus = "prepared" | "launching" | "launched" | "acked" | "failed";

export interface LaunchRecord {
  checkpointId: string;
  checksum: string;
  sourceSessionId: string;
  sourceSessionFile: string | null;
  targetSessionId: string | null;
  leaseId: string;
  leaseSequence: number;
  leaseExpiresAt: string;
  status: LaunchStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  error: string | null;
}

export interface ExtensionStateV1 {
  schemaVersion: "1";
  sequenceBySession: Record<string, number>;
  launches: Record<string, LaunchRecord>;
  commandHistory: CommandRunMetadata[];
  thresholdStageBySession: Record<string, ThresholdStage>;
}

export interface AckChallengePayload {
  checkpointId: string;
  checksum: string;
  targetSessionId: string;
  leaseId: string;
  facts: CheckpointCriticalFacts;
}

export interface StateLimits {
  maxCommandHistory: number;
  maxLaunchRecords: number;
}

export interface ThresholdNotificationConfig {
  enabled: boolean;
  suppressInNonTestBuilderProcess: boolean;
}

export interface FreshSessionConfig {
  thresholds: ThresholdConfig;
  thresholdNotifications: ThresholdNotificationConfig;
  checkpointTtlMinutes: number;
  leaseTtlSeconds: number;
  stateLimits: StateLimits;
  manifestPath: string;
}

export interface CheckpointStaleness {
  stale: boolean;
  reasons: string[];
}
