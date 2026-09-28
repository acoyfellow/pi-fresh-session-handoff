import { buildAckTemplate, buildRuntimeFacts, parseAckPayload, validateAckPayload } from "./core/ack.js";
import { verifyCheckpointChecksum } from "./core/checkpoint.js";
import { loadConfig } from "./core/config.js";
import { LAUNCH_ENTRY_TYPE } from "./core/constants.js";
import { collectGitSnapshot } from "./core/git.js";
import { snapshotModel, validateRequiredModel, type ModelValidationResult } from "./core/model.js";
import { assessToolCall, shouldBlockForAck } from "./core/mutation-guard.js";
import { resolveStorePaths } from "./core/paths.js";
import { findDirtyProtectedPaths, findProtectedPathMutations } from "./core/protected-paths.js";
import {
  assertCheckpointFresh,
  createStores,
  loadCheckpointForLaunch,
  parseAckInput,
  parseLaunchArgs,
  pendingLaunchForSession,
  prepareCheckpoint,
  renderModelInvariant,
} from "./core/service.js";
import { findLatestLaunchMarker } from "./core/session-markers.js";
import { FreshSessionStateStore } from "./core/state-store.js";
import { loadTaskManifest } from "./core/task-manifest.js";
import {
  evaluateThreshold,
  shouldDisableExtensionBehavior,
  shouldEmitThresholdNotifications,
  shouldNotifyThresholdTransition,
} from "./core/thresholds.js";
import {
  conversationFromEntries,
  instantiateHook,
  loadHookSpecs,
  runHookWithTimeout,
  type HookFactory,
  type HookRunOutcome,
  type ReachedThresholdStage,
} from "./core/hooks.js";
import type { CheckpointCriticalFacts, TaskManifestV1, ThresholdStage } from "./core/types.js";
import { dejaAutoMemoryFactory } from "./hooks/deja-auto-memory.js";
import { collectUntrustedInstructionData } from "./core/untrusted-instructions.js";
import type { ExtensionApiLike, ExtensionCommandContextLike, ExtensionContextLike } from "./pi-types.js";

function notify(ctx: ExtensionContextLike, level: "info" | "warning" | "error", message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  if (level === "error") {
    console.error(message);
    return;
  }
  console.log(message);
}

function isModelInRegistry(ctx: ExtensionContextLike, provider: string, id: string): boolean {
  try {
    return Boolean(ctx.modelRegistry.find(provider, id));
  } catch {
    return false;
  }
}

async function validateActiveModel(ctx: ExtensionContextLike): Promise<ModelValidationResult> {
  const { manifest } = await loadManifestPolicy(ctx.cwd);
  const required = manifest.requiredModel;
  return validateRequiredModel(
    snapshotModel(ctx.model),
    ctx.scopedModels,
    required ? isModelInRegistry(ctx, required.provider, required.id) : true,
    required,
  );
}

function currentSessionInfo(ctx: ExtensionContextLike): {
  sessionId: string;
  sessionFile: string | null;
  leafId: string | null;
  parentSession: string | null;
} {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const header = ctx.sessionManager.getHeader();
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: typeof sessionFile === "string" ? sessionFile : null,
    leafId: ctx.sessionManager.getLeafId(),
    parentSession: typeof header?.parentSession === "string" ? header.parentSession : null,
  };
}

function criticalFactMismatches(a: CheckpointCriticalFacts, b: CheckpointCriticalFacts): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(a) as Array<keyof CheckpointCriticalFacts>) {
    if (a[key] !== b[key]) {
      mismatches.push(String(key));
    }
  }
  return mismatches;
}

async function stateStoreFor(ctx: ExtensionContextLike): Promise<FreshSessionStateStore> {
  const config = await loadConfig(ctx.cwd);
  const paths = await resolveStorePaths(ctx.cwd);
  return new FreshSessionStateStore(paths.stateFile, paths.lockFile, config.stateLimits);
}

async function loadManifestPolicy(cwd: string): Promise<{ manifest: TaskManifestV1; manifestPath: string }> {
  const config = await loadConfig(cwd);
  const manifest = await loadTaskManifest(config.manifestPath);
  return {
    manifest,
    manifestPath: config.manifestPath,
  };
}

async function assertProtectedPathsClean(cwd: string, manifest: TaskManifestV1): Promise<void> {
  const git = await collectGitSnapshot(cwd);
  const dirtyProtected = findDirtyProtectedPaths(cwd, manifest.protectedPaths, git.snapshot);
  if (dirtyProtected.length > 0) {
    throw new Error(`protected paths are dirty: ${dirtyProtected.join(",")}`);
  }
}

async function handleStatus(_args: string, ctx: ExtensionCommandContextLike): Promise<void> {
  const config = await loadConfig(ctx.cwd);
  const model = snapshotModel(ctx.model);
  const modelValidation = await validateActiveModel(ctx);
  const usageRaw = ctx.getContextUsage();
  const usage =
    typeof usageRaw === "object" && usageRaw !== null
      ? (usageRaw as { tokens?: number | null; percent?: number | null })
      : { tokens: null, percent: null };
  const stage = evaluateThreshold({ tokens: usage.tokens ?? null, percent: usage.percent ?? null }, config.thresholds);

  const sessionId = ctx.sessionManager.getSessionId();
  const { launch } = await pendingLaunchForSession(ctx.cwd, sessionId);

  notify(ctx, "info", `model=${renderModelInvariant(model)}`);
  if (!modelValidation.ok) {
    notify(ctx, "warning", `model-check failed: ${modelValidation.reasons.join(" | ")}`);
  } else {
    notify(ctx, "info", "model-check passed");
  }

  const tokensText = usage.tokens === null || usage.tokens === undefined ? "unknown" : String(usage.tokens);
  const percentText = usage.percent === null || usage.percent === undefined ? "unknown" : String(usage.percent);
  notify(ctx, "info", `context usage tokens=${tokensText} percent=${percentText} stage=${stage}`);

  if (launch) {
    notify(
      ctx,
      "warning",
      `pending launch checkpoint=${launch.checkpointId} checksum=${launch.checksum} status=${launch.status}`,
    );
  } else {
    notify(ctx, "info", "pending launch=none");
  }

  notify(ctx, "info", `manifest path=${config.manifestPath}`);
}

async function handlePrepare(args: string, ctx: ExtensionCommandContextLike): Promise<void> {
  await ctx.waitForIdle();

  const result = await prepareCheckpoint({
    cwd: ctx.cwd,
    session: currentSessionInfo(ctx),
    model: ctx.model,
    scopedModels: ctx.scopedModels,
    isModelInRegistry: (provider: string, id: string) => isModelInRegistry(ctx, provider, id),
    contextUsage: ctx.getContextUsage(),
  });

  await result.stateStore.recordCommand({
    command: `/fresh-handoff-prepare ${args}`.trim(),
    kind: "state",
    startedAt: result.checkpoint.createdAt,
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: 0,
  });

  if (result.reused) {
    notify(
      ctx,
      "info",
      `checkpoint reused id=${result.checkpoint.checkpointId} checksum=${result.checkpoint.checksum}`,
    );
  } else {
    notify(
      ctx,
      "info",
      `checkpoint prepared id=${result.checkpoint.checkpointId} checksum=${result.checkpoint.checksum}`,
    );
  }
  notify(ctx, "info", `checkpoint file=${result.checkpointPath}`);
  ctx.ui.setEditorText(`/fresh-handoff-launch ${result.checkpoint.checkpointId}`);
}

function buildChallengeMessage(checkpointId: string, checksum: string, leaseId: string, factsJson: string): string {
  return [
    "Fresh session handoff is active.",
    "Before any editing tools run, acknowledge this checkpoint:",
    `checkpointId=${checkpointId}`,
    `checksum=${checksum}`,
    `leaseId=${leaseId}`,
    `facts=${factsJson}`,
    "Run the prefilled /fresh-handoff-ack command in this session.",
  ].join("\n");
}

async function handleLaunch(args: string, ctx: ExtensionCommandContextLike): Promise<void> {
  await ctx.waitForIdle();

  const parsed = parseLaunchArgs(args);
  const session = currentSessionInfo(ctx);
  const model = snapshotModel(ctx.model);
  const modelValidation = await validateActiveModel(ctx);
  if (!modelValidation.ok) {
    throw new Error(modelValidation.reasons.join("; "));
  }

  const { checkpoint, config, stateStore } = await loadCheckpointForLaunch(
    ctx.cwd,
    session.sessionId,
    parsed.checkpointId,
  );

  if (!verifyCheckpointChecksum(checkpoint)) {
    throw new Error("Checkpoint checksum verification failed");
  }

  const manifest = await loadTaskManifest(config.manifestPath);
  await assertProtectedPathsClean(ctx.cwd, manifest);

  const launchGit = await collectGitSnapshot(ctx.cwd);
  const untrustedInstructionData = await collectUntrustedInstructionData(ctx.cwd, manifest.untrustedInstructionPaths);
  const launchFacts = buildRuntimeFacts({
    checkpoint,
    model,
    git: launchGit.snapshot,
    manifest,
    untrustedInstructionData,
  });
  const mismatches = criticalFactMismatches(checkpoint.criticalFacts, launchFacts);
  if (mismatches.length > 0) {
    throw new Error(`Checkpoint runtime facts changed: ${mismatches.join(",")}`);
  }

  const currentSequence = await stateStore.getSequence(session.sessionId);
  if (!parsed.force) {
    await assertCheckpointFresh(checkpoint, {
      cwd: ctx.cwd,
      sessionId: session.sessionId,
      sequence: currentSequence,
    });
  }

  const lease = await stateStore.acquireLaunchLease({
    checkpointId: checkpoint.checkpointId,
    checksum: checkpoint.checksum,
    sourceSessionId: checkpoint.session.sessionId,
    sourceSessionFile: checkpoint.session.sessionFile,
    expiresAt: checkpoint.expiresAt,
    leaseTtlSeconds: config.leaseTtlSeconds,
  });

  if (!lease.acquired) {
    notify(
      ctx,
      "warning",
      `launch deduped checkpoint=${lease.record.checkpointId} status=${lease.record.status} reason=${lease.reason}`,
    );
    return;
  }

  let targetSessionId: string | null = null;
  const challenge = buildChallengeMessage(
    checkpoint.checkpointId,
    checkpoint.checksum,
    lease.record.leaseId,
    JSON.stringify(checkpoint.criticalFacts),
  );

  const launchResult = await ctx.newSession({
    parentSession: session.sessionFile ?? undefined,
    setup: (sessionManager) => {
      sessionManager.appendCustomEntry(LAUNCH_ENTRY_TYPE, {
        checkpointId: checkpoint.checkpointId,
        checksum: checkpoint.checksum,
        leaseId: lease.record.leaseId,
        criticalFacts: checkpoint.criticalFacts,
      });
      sessionManager.appendCustomMessageEntry(LAUNCH_ENTRY_TYPE, challenge, true, {
        checkpointId: checkpoint.checkpointId,
        checksum: checkpoint.checksum,
        leaseId: lease.record.leaseId,
      });
    },
    withSession: async (replacementCtx) => {
      targetSessionId = replacementCtx.sessionManager.getSessionId();
      const ackTemplate = buildAckTemplate(checkpoint, targetSessionId, lease.record.leaseId);
      replacementCtx.ui.setEditorText(`/fresh-handoff-ack ${ackTemplate}`);
      replacementCtx.ui.notify("Acknowledge checkpoint before editing", "warning");
    },
  });

  if (launchResult.cancelled) {
    await stateStore.markLaunchFailed(checkpoint.checkpointId, lease.record.leaseId, "session replacement cancelled");
    notify(ctx, "warning", "launch cancelled");
    return;
  }

  const launched = await stateStore.markLaunchLaunched(checkpoint.checkpointId, lease.record.leaseId, targetSessionId);
  if (!launched.updated) {
    throw new Error(`launch state transition failed: ${launched.reason}`);
  }

  await stateStore.recordCommand({
    command: `/fresh-handoff-launch ${args}`.trim(),
    kind: "launcher",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: 0,
  });
}

async function handleAck(args: string, ctx: ExtensionCommandContextLike): Promise<void> {
  await ctx.waitForIdle();

  const sessionId = ctx.sessionManager.getSessionId();
  const { launch, stateStore, config } = await pendingLaunchForSession(ctx.cwd, sessionId);
  if (!launch) {
    throw new Error("No pending launch found for this session");
  }
  if (launch.status !== "launched") {
    throw new Error(`Launch is not ready for ack: ${launch.status}`);
  }

  const { checkpointStore } = await createStores(ctx.cwd, config);
  const checkpoint = await checkpointStore.load(launch.checkpointId);
  if (!checkpoint) {
    throw new Error(`Checkpoint not found: ${launch.checkpointId}`);
  }

  if (!verifyCheckpointChecksum(checkpoint)) {
    throw new Error("Checkpoint checksum verification failed");
  }

  const model = snapshotModel(ctx.model);
  const modelValidation = await validateActiveModel(ctx);
  if (!modelValidation.ok) {
    throw new Error(modelValidation.reasons.join("; "));
  }

  const manifest = await loadTaskManifest(config.manifestPath);
  await assertProtectedPathsClean(ctx.cwd, manifest);

  const payload = parseAckPayload(JSON.stringify(await parseAckInput(args)));
  const git = await collectGitSnapshot(ctx.cwd);
  const untrustedInstructionData = await collectUntrustedInstructionData(ctx.cwd, manifest.untrustedInstructionPaths);
  const runtimeFacts = buildRuntimeFacts({
    checkpoint,
    model,
    git: git.snapshot,
    manifest,
    untrustedInstructionData,
  });
  const validation = validateAckPayload(checkpoint, payload, runtimeFacts, {
    checkpointId: launch.checkpointId,
    checksum: launch.checksum,
    targetSessionId: sessionId,
    leaseId: launch.leaseId,
  });

  if (!validation.ok) {
    throw new Error(`Ack validation failed: ${validation.errors.join(",")}`);
  }

  const acked = await stateStore.markLaunchAcked(checkpoint.checkpointId, launch.leaseId, sessionId, checkpoint.checksum);
  if (!acked.updated) {
    throw new Error(`Ack transition failed: ${acked.reason}`);
  }

  await stateStore.recordCommand({
    command: `/fresh-handoff-ack ${args}`.trim(),
    kind: "state",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: 0,
  });

  notify(ctx, "info", "Ack verified. Editing tools are enabled.");
}

function eventToolName(event: unknown): string {
  if (typeof event !== "object" || event === null) {
    return "";
  }
  const source = event as Record<string, unknown>;
  return typeof source.toolName === "string" ? source.toolName : "";
}

function eventToolInput(event: unknown): unknown {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const source = event as Record<string, unknown>;
  return source.input;
}

function pathCandidatesFromUnknownToolInput(input: unknown): string[] {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const candidates: string[] = [];
  const queue: unknown[] = [input];
  const keyPattern = /(path|file|target|destination|output)/i;

  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) {
      queue.push(...next);
      continue;
    }
    if (typeof next !== "object" || next === null) {
      continue;
    }

    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
        queue.push(value);
        continue;
      }
      if (!keyPattern.test(key)) {
        continue;
      }
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      candidates.push(trimmed);
    }
  }

  return [...new Set(candidates)];
}

async function protectedPathBlockReason(
  ctx: ExtensionContextLike,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  const { manifest } = await loadManifestPolicy(ctx.cwd);
  const assessment = assessToolCall(toolName, input);

  if (assessment.kind === "read-only") {
    return null;
  }

  const candidatePaths =
    assessment.kind === "unknown"
      ? pathCandidatesFromUnknownToolInput(input)
      : assessment.explicitMutationPaths;

  if (!candidatePaths || candidatePaths.length === 0) {
    if (assessment.kind === "unknown") {
      return null;
    }
    return `blocked mutating tool ${toolName}: protected path guard could not verify mutation targets`;
  }

  const violations = findProtectedPathMutations(ctx.cwd, manifest.protectedPaths, candidatePaths);
  if (violations.length === 0) {
    return null;
  }

  return `blocked protected path mutation: ${violations.join(",")}`;
}

async function sessionRequiresAck(ctx: ExtensionContextLike): Promise<boolean> {
  const sessionId = ctx.sessionManager.getSessionId();
  const { launch, stateStore } = await pendingLaunchForSession(ctx.cwd, sessionId);
  if (launch) {
    return true;
  }

  const marker = findLatestLaunchMarker(ctx.sessionManager.getEntries());
  if (!marker) {
    return false;
  }

  const launchState = await stateStore.getLaunch(marker.checkpointId);
  if (!launchState) {
    return true;
  }
  return launchState.status !== "acked";
}

async function handleThresholdEvent(ctx: ExtensionContextLike): Promise<void> {
  const usageRaw = ctx.getContextUsage();
  const usage =
    typeof usageRaw === "object" && usageRaw !== null
      ? (usageRaw as { tokens?: number | null; percent?: number | null })
      : { tokens: null, percent: null };

  const config = await loadConfig(ctx.cwd);
  const stage = evaluateThreshold({ tokens: usage.tokens ?? null, percent: usage.percent ?? null }, config.thresholds);

  const stateStore = await stateStoreFor(ctx);
  const sessionId = ctx.sessionManager.getSessionId();
  const previousStage = await stateStore.getThresholdStage(sessionId);
  const notificationsEnabled = shouldEmitThresholdNotifications(config.thresholdNotifications);

  if (notificationsEnabled && shouldNotifyThresholdTransition(previousStage, stage)) {
    if (stage === "warning") {
      notify(ctx, "warning", "Context warning threshold reached. Prepare a handoff checkpoint.");
    } else if (stage === "prepare") {
      notify(ctx, "warning", "Context prepare threshold reached. Run /fresh-handoff-prepare.");
    } else if (stage === "force") {
      notify(ctx, "warning", "Context force threshold reached. Launch only with fresh checkpoint or --force.");
    }
  }

  await stateStore.setThresholdStage(sessionId, stage);

  if (stage !== "below" && shouldNotifyThresholdTransition(previousStage, stage)) {
    startThresholdHooks(ctx, stage, previousStage, { tokens: usage.tokens ?? null, percent: usage.percent ?? null });
  }
}

const builtinHooks: Record<string, HookFactory> = {
  "deja-auto-memory": dejaAutoMemoryFactory,
};

const runningHookBatches = new Map<string, Promise<unknown>>();

export const HOOK_SHUTDOWN_GRACE_MS = 150_000;

export async function waitForRunningHooks(sessionId: string, graceMs = HOOK_SHUTDOWN_GRACE_MS): Promise<boolean> {
  const running = runningHookBatches.get(sessionId);
  if (!running) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });
  try {
    return await Promise.race([running.then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function completeWithModel(ctx: ExtensionContextLike, prompt: string): Promise<string> {
  const complete = ctx.modelRegistry.complete;
  if (!ctx.model || typeof complete !== "function") throw new Error("current model is unavailable for hook completion");
  const response = await complete.call(
    ctx.modelRegistry,
    ctx.model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { cacheRetention: "none" },
  );
  return response.content
    .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
    .map((part) => part.text)
    .join("\n");
}

export async function runThresholdHooks(
  ctx: ExtensionContextLike,
  stage: ReachedThresholdStage,
  previousStage: ThresholdStage | undefined,
  usage: { tokens: number | null; percent: number | null },
): Promise<HookRunOutcome[]> {
  const specs = await loadHookSpecs(ctx.cwd);
  if (specs.length === 0) return [];
  const event = {
    stage,
    previousStage,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    usage,
    conversation: conversationFromEntries(ctx.sessionManager.getEntries()),
  };
  const tools = {
    completeWithCurrentModel: (prompt: string) => completeWithModel(ctx, prompt),
    notify: (message: string, level: "info" | "warning" | "error" = "info") => notify(ctx, level, message),
  };
  const outcomes: HookRunOutcome[] = [];
  for (const spec of specs) {
    try {
      const loaded = await instantiateHook(spec, builtinHooks);
      const outcome = await runHookWithTimeout(loaded, event, tools);
      if (outcome.status === "failed" || outcome.status === "timed_out") {
        notify(ctx, "warning", `hook ${outcome.name} ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`);
      }
      outcomes.push(outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, "warning", `hook ${spec.module} failed to load: ${message}`);
      outcomes.push({ name: spec.module, status: "failed", error: message });
    }
  }
  return outcomes;
}

function startThresholdHooks(
  ctx: ExtensionContextLike,
  stage: ReachedThresholdStage,
  previousStage: ThresholdStage | undefined,
  usage: { tokens: number | null; percent: number | null },
): void {
  const sessionId = ctx.sessionManager.getSessionId();
  if (runningHookBatches.has(sessionId)) return;
  const batch = runThresholdHooks(ctx, stage, previousStage, usage)
    .catch(() => undefined)
    .finally(() => runningHookBatches.delete(sessionId));
  runningHookBatches.set(sessionId, batch);
}

export default function createFreshSessionHandoffExtension(pi: ExtensionApiLike): void {
  if (shouldDisableExtensionBehavior()) {
    return;
  }

  pi.registerCommand("fresh-handoff-status", {
    description: "Show fresh handoff status and model/context invariants",
    handler: async (args, ctx) => {
      try {
        await handleStatus(args, ctx);
      } catch (error) {
        notify(ctx, "error", String(error));
      }
    },
  });

  pi.registerCommand("fresh-handoff-prepare", {
    description: "Create a checkpoint for safe fresh-session handoff",
    handler: async (args, ctx) => {
      try {
        await handlePrepare(args, ctx);
      } catch (error) {
        notify(ctx, "error", String(error));
      }
    },
  });

  pi.registerCommand("fresh-handoff-launch", {
    description: "Launch a fresh session from checkpoint with idempotent lease guard",
    handler: async (args, ctx) => {
      try {
        await handleLaunch(args, ctx);
      } catch (error) {
        notify(ctx, "error", String(error));
      }
    },
  });

  pi.registerCommand("fresh-handoff-ack", {
    description: "Acknowledge checkpoint challenge in the fresh session",
    handler: async (args, ctx) => {
      try {
        await handleAck(args, ctx);
      } catch (error) {
        notify(ctx, "error", String(error));
      }
    },
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      await handleThresholdEvent(ctx);
    } catch {
      return;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const needsAck = await sessionRequiresAck(ctx);
      if (needsAck) {
        notify(ctx, "warning", "Run /fresh-handoff-ack before editing tools.");
      }
    } catch {
      return;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const finished = await waitForRunningHooks(ctx.sessionManager.getSessionId());
      if (!finished) notify(ctx, "warning", "threshold hooks still running at shutdown; results may be incomplete");
    } catch {
      return;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      const toolName = eventToolName(event);
      if (!toolName) {
        return;
      }

      const toolInput = eventToolInput(event);
      const protectedReason = await protectedPathBlockReason(ctx, toolName, toolInput);
      if (protectedReason) {
        return {
          block: true,
          reason: protectedReason,
        };
      }

      const needsAck = await sessionRequiresAck(ctx);
      if (!needsAck) {
        return;
      }

      const shouldBlock = shouldBlockForAck(needsAck, toolName, toolInput);
      if (!shouldBlock) {
        return;
      }

      return {
        block: true,
        reason: "fresh-handoff ack required before editing. Run /fresh-handoff-ack with checkpoint payload.",
      };
    } catch {
      return;
    }
  });
}
