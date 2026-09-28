import { hostname } from "node:os";

import { CheckpointStore } from "./checkpoint-store.js";
import { buildCriticalFacts, createCheckpoint, verifyCheckpointChecksum } from "./checkpoint.js";
import { loadConfig } from "./config.js";
import { snapshotContextUsage } from "./context-usage.js";
import { collectGitSnapshot } from "./git.js";
import { validateRequiredModel, snapshotModel } from "./model.js";
import { resolveStorePaths } from "./paths.js";
import { findDirtyProtectedPaths } from "./protected-paths.js";
import { buildRedactionReport } from "./redaction.js";
import { FreshSessionStateStore } from "./state-store.js";
import { evaluateCheckpointStaleness } from "./stale.js";
import { loadTaskManifest } from "./task-manifest.js";
import { collectUntrustedInstructionData } from "./untrusted-instructions.js";
import type {
  AckChallengePayload,
  CheckpointCriticalFacts,
  CommandRunMetadata,
  FreshSessionCheckpointV1,
  FreshSessionConfig,
  LaunchRecord,
  ModelSnapshot,
  TaskManifestV1,
} from "./types.js";

export interface RuntimeSessionInfo {
  sessionId: string;
  sessionFile: string | null;
  leafId: string | null;
  parentSession: string | null;
}

export interface PrepareCheckpointInput {
  cwd: string;
  session: RuntimeSessionInfo;
  model: unknown;
  scopedModels: unknown[];
  isModelInRegistry: (provider: string, id: string) => boolean;
  contextUsage: unknown;
}

export interface PrepareCheckpointResult {
  checkpoint: FreshSessionCheckpointV1;
  checkpointPath: string;
  config: FreshSessionConfig;
  stateStore: FreshSessionStateStore;
  checkpointStore: CheckpointStore;
  reused: boolean;
}

function syntheticCommandMetadata(command: string, kind: CommandRunMetadata["kind"]): CommandRunMetadata {
  const now = new Date().toISOString();
  return {
    command,
    kind,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    exitCode: 0,
  };
}

function ensureManifestInvariant(manifest: TaskManifestV1): string[] {
  const required = manifest.requiredModel;
  if (!required) return [];
  const forbidden = new Set(manifest.forbiddenModels);
  if (forbidden.has(required.id) || forbidden.has(`${required.provider}/${required.id}`)) {
    return ["manifest forbids required model"];
  }
  return [];
}

function compareCriticalFacts(a: CheckpointCriticalFacts, b: CheckpointCriticalFacts): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(a) as Array<keyof CheckpointCriticalFacts>) {
    if (a[key] !== b[key]) {
      mismatches.push(String(key));
    }
  }
  return mismatches;
}

function isCheckpointExpired(checkpoint: FreshSessionCheckpointV1): boolean {
  return Date.parse(checkpoint.expiresAt) <= Date.now();
}

async function assertProtectedPathsClean(cwd: string, manifest: TaskManifestV1): Promise<void> {
  const git = await collectGitSnapshot(cwd);
  const dirtyProtectedPaths = findDirtyProtectedPaths(cwd, manifest.protectedPaths, git.snapshot);
  if (dirtyProtectedPaths.length > 0) {
    throw new Error(`protected paths are dirty: ${dirtyProtectedPaths.join(",")}`);
  }
}

function checkpointMatchesRuntime(
  checkpoint: FreshSessionCheckpointV1,
  runtime: {
    sessionId: string;
    model: ModelSnapshot;
    git: FreshSessionCheckpointV1["git"];
    manifest: TaskManifestV1;
    untrustedInstructionData: FreshSessionCheckpointV1["untrustedInstructionData"];
  },
): boolean {
  if (checkpoint.session.sessionId !== runtime.sessionId) {
    return false;
  }
  if (checkpoint.model.provider !== runtime.model.provider) {
    return false;
  }
  if (checkpoint.model.id !== runtime.model.id) {
    return false;
  }
  if (checkpoint.model.route !== runtime.model.route) {
    return false;
  }
  if (checkpoint.git.branch !== runtime.git.branch) {
    return false;
  }
  if (checkpoint.git.commit !== runtime.git.commit) {
    return false;
  }
  if (checkpoint.git.statusDigest !== runtime.git.statusDigest) {
    return false;
  }
  if (isCheckpointExpired(checkpoint)) {
    return false;
  }

  const expectedFacts = buildCriticalFacts(
    runtime.manifest,
    runtime.model,
    runtime.git,
    checkpoint.sequence,
    runtime.untrustedInstructionData,
  );

  const mismatches = compareCriticalFacts(checkpoint.criticalFacts, expectedFacts);
  return mismatches.length === 0;
}

async function reusablePreparedCheckpoint(
  checkpointStore: CheckpointStore,
  stateStore: FreshSessionStateStore,
  runtime: {
    sessionId: string;
    model: ModelSnapshot;
    git: FreshSessionCheckpointV1["git"];
    manifest: TaskManifestV1;
    untrustedInstructionData: FreshSessionCheckpointV1["untrustedInstructionData"];
  },
): Promise<FreshSessionCheckpointV1 | null> {
  const latestPrepared = await stateStore.latestPreparedLaunch(runtime.sessionId);
  if (!latestPrepared) {
    return null;
  }

  const checkpoint = await checkpointStore.load(latestPrepared.checkpointId);
  if (!checkpoint) {
    return null;
  }

  if (!verifyCheckpointChecksum(checkpoint)) {
    return null;
  }

  if (!checkpointMatchesRuntime(checkpoint, runtime)) {
    return null;
  }

  return checkpoint;
}

export async function createStores(cwd: string, config: FreshSessionConfig): Promise<{
  stateStore: FreshSessionStateStore;
  checkpointStore: CheckpointStore;
}> {
  const paths = await resolveStorePaths(cwd);
  return {
    stateStore: new FreshSessionStateStore(paths.stateFile, paths.lockFile, config.stateLimits),
    checkpointStore: new CheckpointStore(paths.rootDir, paths.checkpointsDir),
  };
}

export async function prepareCheckpoint(input: PrepareCheckpointInput): Promise<PrepareCheckpointResult> {
  const config = await loadConfig(input.cwd);
  const { stateStore, checkpointStore } = await createStores(input.cwd, config);
  const manifest = await loadTaskManifest(config.manifestPath);
  const manifestErrors = ensureManifestInvariant(manifest);
  if (manifestErrors.length > 0) {
    throw new Error(manifestErrors.join("; "));
  }

  const model = snapshotModel(input.model);
  const modelValidation = validateRequiredModel(
    model,
    input.scopedModels,
    manifest.requiredModel ? input.isModelInRegistry(manifest.requiredModel.provider, manifest.requiredModel.id) : true,
    manifest.requiredModel,
  );
  if (!modelValidation.ok) {
    throw new Error(modelValidation.reasons.join("; "));
  }

  await assertProtectedPathsClean(input.cwd, manifest);

  const git = await collectGitSnapshot(input.cwd);
  const usage = snapshotContextUsage(input.contextUsage);
  const redaction = buildRedactionReport(process.env);
  const history = await stateStore.getCommandHistory();
  const untrustedInstructionData = await collectUntrustedInstructionData(
    input.cwd,
    manifest.untrustedInstructionPaths,
  );

  const reusedCheckpoint = await reusablePreparedCheckpoint(checkpointStore, stateStore, {
    sessionId: input.session.sessionId,
    model,
    git: git.snapshot,
    manifest,
    untrustedInstructionData,
  });

  if (reusedCheckpoint) {
    await stateStore.recordCommand(
      syntheticCommandMetadata(`checkpoint-reused ${reusedCheckpoint.checkpointId}`, "state"),
    );

    return {
      checkpoint: reusedCheckpoint,
      checkpointPath: checkpointStore.filePathFor(reusedCheckpoint.checkpointId),
      config,
      stateStore,
      checkpointStore,
      reused: true,
    };
  }

  const sequence = await stateStore.nextSequence(input.session.sessionId);

  const commandMetadata = [
    ...history,
    ...git.commandMetadata,
    syntheticCommandMetadata(`prepare-checkpoint ${input.session.sessionId}:${sequence}`, "state"),
  ];

  const expiresAt = new Date(
    Date.now() + Math.min(manifest.expiresMinutes, config.checkpointTtlMinutes) * 60 * 1000,
  ).toISOString();

  const checkpoint = createCheckpoint({
    sessionId: input.session.sessionId,
    sessionFile: input.session.sessionFile,
    leafId: input.session.leafId,
    parentSession: input.session.parentSession,
    sequence,
    createdAt: new Date().toISOString(),
    expiresAt,
    usage,
    model,
    git: git.snapshot,
    taskManifest: manifest,
    untrustedInstructionData,
    commandMetadata,
    redaction,
    machine: hostname(),
  });

  const checkpointPath = await checkpointStore.save(checkpoint);
  await stateStore.registerPreparedCheckpoint(checkpoint);
  await stateStore.recordCommand(syntheticCommandMetadata(`checkpoint-saved ${checkpoint.checkpointId}`, "state"));

  return {
    checkpoint,
    checkpointPath,
    config,
    stateStore,
    checkpointStore,
    reused: false,
  };
}

export async function loadCheckpointForLaunch(
  cwd: string,
  sessionId: string,
  checkpointId: string | null,
): Promise<{ checkpoint: FreshSessionCheckpointV1; config: FreshSessionConfig; stateStore: FreshSessionStateStore }> {
  const config = await loadConfig(cwd);
  const { stateStore, checkpointStore } = await createStores(cwd, config);

  let checkpoint: FreshSessionCheckpointV1 | null = null;
  if (checkpointId) {
    checkpoint = await checkpointStore.load(checkpointId);
  } else {
    const latestId = await stateStore.latestPreparedCheckpointId(sessionId);
    checkpoint = latestId ? await checkpointStore.load(latestId) : null;
    if (!checkpoint) {
      checkpoint = await checkpointStore.latestForSession(sessionId);
    }
  }

  if (!checkpoint) {
    throw new Error("No checkpoint found");
  }

  return {
    checkpoint,
    config,
    stateStore,
  };
}

export async function assertCheckpointFresh(
  checkpoint: FreshSessionCheckpointV1,
  input: { cwd: string; sessionId: string; sequence: number },
): Promise<void> {
  const git = await collectGitSnapshot(input.cwd);
  const staleness = evaluateCheckpointStaleness(checkpoint, {
    sessionId: input.sessionId,
    sequence: input.sequence,
    now: new Date(),
    git: git.snapshot,
  });
  if (staleness.stale) {
    throw new Error(`Checkpoint is stale: ${staleness.reasons.join(",")}`);
  }
}

export async function parseAckInput(args: string): Promise<AckChallengePayload> {
  const trimmed = args.trim();
  if (!trimmed) {
    throw new Error("Ack payload is required");
  }

  if (trimmed.startsWith("@")) {
    throw new Error("Ack payload must be inline JSON");
  }

  return JSON.parse(trimmed) as AckChallengePayload;
}

export function parseLaunchArgs(args: string): { checkpointId: string | null; force: boolean } {
  const tokens = args
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  let checkpointId: string | null = null;
  let force = false;

  for (const token of tokens) {
    if (token === "--force") {
      force = true;
      continue;
    }
    if (!checkpointId) {
      checkpointId = token;
    }
  }

  return { checkpointId, force };
}

export async function pendingLaunchForSession(
  cwd: string,
  sessionId: string,
): Promise<{ launch: LaunchRecord | null; stateStore: FreshSessionStateStore; config: FreshSessionConfig }> {
  const config = await loadConfig(cwd);
  const { stateStore } = await createStores(cwd, config);
  const launch = await stateStore.getPendingLaunchForTargetSession(sessionId);
  return { launch, stateStore, config };
}

export function renderModelInvariant(model: ModelSnapshot): string {
  return `${model.provider}/${model.id} route=${model.route}`;
}
