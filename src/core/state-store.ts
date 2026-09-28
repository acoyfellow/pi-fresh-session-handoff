import path from "node:path";

import { withFileLock, readJsonFile, writeJsonAtomic } from "./atomic.js";
import { assertSafePath } from "./paths.js";
import type {
  CommandRunMetadata,
  ExtensionStateV1,
  FreshSessionCheckpointV1,
  LaunchRecord,
  ThresholdStage,
} from "./types.js";
import { nowIso, newLeaseId } from "./utils.js";
import type { StateLimits } from "./types.js";

const maxStoredCommandLength = 320;

function createEmptyState(): ExtensionStateV1 {
  return {
    schemaVersion: "1",
    sequenceBySession: {},
    launches: {},
    commandHistory: [],
    thresholdStageBySession: {},
  };
}

function trimCommandHistory(history: CommandRunMetadata[], maxCommandHistory: number): CommandRunMetadata[] {
  if (history.length <= maxCommandHistory) {
    return history;
  }
  return history.slice(history.length - maxCommandHistory);
}

function trimLaunches(launches: Record<string, LaunchRecord>, maxLaunchRecords: number): Record<string, LaunchRecord> {
  const entries = Object.entries(launches);
  if (entries.length <= maxLaunchRecords) {
    return launches;
  }

  const sorted = entries.sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
  const keep = sorted.slice(sorted.length - maxLaunchRecords);
  return Object.fromEntries(keep);
}

function sanitizeCommandText(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "[empty-command]";
  }

  if (trimmed.startsWith("/fresh-handoff-ack")) {
    return "/fresh-handoff-ack [redacted]";
  }

  if (trimmed.length > maxStoredCommandLength) {
    return `${trimmed.slice(0, maxStoredCommandLength)}…`;
  }

  return trimmed;
}

function sanitizeCommandMetadata(metadata: CommandRunMetadata): CommandRunMetadata {
  return {
    ...metadata,
    command: sanitizeCommandText(metadata.command),
  };
}

function normalizeLaunchRecord(raw: unknown): LaunchRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const source = raw as Record<string, unknown>;
  if (typeof source.checkpointId !== "string") {
    return null;
  }

  return {
    checkpointId: source.checkpointId,
    checksum: typeof source.checksum === "string" ? source.checksum : "",
    sourceSessionId: typeof source.sourceSessionId === "string" ? source.sourceSessionId : "",
    sourceSessionFile: typeof source.sourceSessionFile === "string" ? source.sourceSessionFile : null,
    targetSessionId: typeof source.targetSessionId === "string" ? source.targetSessionId : null,
    leaseId: typeof source.leaseId === "string" ? source.leaseId : "",
    leaseSequence: typeof source.leaseSequence === "number" ? source.leaseSequence : 0,
    leaseExpiresAt: typeof source.leaseExpiresAt === "string" ? source.leaseExpiresAt : "",
    status: typeof source.status === "string" ? (source.status as LaunchRecord["status"]) : "prepared",
    createdAt: typeof source.createdAt === "string" ? source.createdAt : nowIso(),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : nowIso(),
    expiresAt: typeof source.expiresAt === "string" ? source.expiresAt : nowIso(),
    error: typeof source.error === "string" ? source.error : null,
  };
}

export interface AcquireLeaseParams {
  checkpointId: string;
  checksum: string;
  sourceSessionId: string;
  sourceSessionFile: string | null;
  expiresAt: string;
  leaseTtlSeconds: number;
}

export interface AcquireLeaseResult {
  acquired: boolean;
  reason: string | null;
  record: LaunchRecord;
}

export interface LaunchTransitionResult {
  updated: boolean;
  reason: string | null;
  record: LaunchRecord | null;
}

export class FreshSessionStateStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private readonly storeRootDir: string;
  private readonly limits: StateLimits;

  constructor(stateFile: string, lockFile: string, limits: StateLimits) {
    const stateDirectory = path.resolve(path.dirname(stateFile));
    const lockDirectory = path.resolve(path.dirname(lockFile));
    if (stateDirectory !== lockDirectory) {
      throw new Error("state and lock files must share a directory");
    }

    this.stateFile = stateFile;
    this.lockFile = lockFile;
    this.storeRootDir = stateDirectory;
    this.limits = limits;
  }

  private async assertSafeStatePaths(): Promise<void> {
    await assertSafePath(this.storeRootDir, this.stateFile, "state file");
    await assertSafePath(this.storeRootDir, this.lockFile, "state lock file");
  }

  async readState(): Promise<ExtensionStateV1> {
    await this.assertSafeStatePaths();
    const raw = await readJsonFile<ExtensionStateV1>(this.stateFile, createEmptyState());
    if (raw.schemaVersion !== "1") {
      return createEmptyState();
    }

    const launches: Record<string, LaunchRecord> = {};
    for (const [checkpointId, recordRaw] of Object.entries(raw.launches ?? {})) {
      const normalized = normalizeLaunchRecord(recordRaw);
      if (!normalized) {
        continue;
      }
      launches[checkpointId] = normalized;
    }

    return {
      schemaVersion: "1",
      sequenceBySession: raw.sequenceBySession ?? {},
      launches,
      commandHistory: (raw.commandHistory ?? []).map(sanitizeCommandMetadata),
      thresholdStageBySession: raw.thresholdStageBySession ?? {},
    };
  }

  private async update<T>(mutate: (state: ExtensionStateV1) => T): Promise<T> {
    await this.assertSafeStatePaths();
    return withFileLock(this.lockFile, 3000, 10000, async () => {
      const current = await this.readState();
      const result = mutate(current);
      current.commandHistory = trimCommandHistory(current.commandHistory, this.limits.maxCommandHistory);
      current.launches = trimLaunches(current.launches, this.limits.maxLaunchRecords);
      await writeJsonAtomic(this.stateFile, current);
      return result;
    });
  }

  async nextSequence(sessionId: string): Promise<number> {
    return this.update((state) => {
      const current = state.sequenceBySession[sessionId] ?? 0;
      const next = current + 1;
      state.sequenceBySession[sessionId] = next;
      return next;
    });
  }

  async getSequence(sessionId: string): Promise<number> {
    const state = await this.readState();
    return state.sequenceBySession[sessionId] ?? 0;
  }

  async recordCommand(metadata: CommandRunMetadata): Promise<void> {
    await this.update((state) => {
      state.commandHistory.push(sanitizeCommandMetadata(metadata));
    });
  }

  async registerPreparedCheckpoint(checkpoint: FreshSessionCheckpointV1): Promise<LaunchRecord> {
    return this.update((state) => {
      const now = nowIso();
      const existing = state.launches[checkpoint.checkpointId];
      const leaseId = existing?.leaseId ?? newLeaseId();
      const leaseExpiresAt = existing?.leaseExpiresAt ?? checkpoint.expiresAt;
      const leaseSequence = existing?.leaseSequence ?? 0;
      const record: LaunchRecord = {
        checkpointId: checkpoint.checkpointId,
        checksum: checkpoint.checksum,
        sourceSessionId: checkpoint.session.sessionId,
        sourceSessionFile: checkpoint.session.sessionFile,
        targetSessionId: existing?.targetSessionId ?? null,
        leaseId,
        leaseSequence,
        leaseExpiresAt,
        status: "prepared",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: checkpoint.expiresAt,
        error: null,
      };
      state.launches[checkpoint.checkpointId] = record;
      return record;
    });
  }

  async acquireLaunchLease(params: AcquireLeaseParams): Promise<AcquireLeaseResult> {
    return this.update((state) => {
      const now = nowIso();
      const nowMs = Date.now();
      const existing = state.launches[params.checkpointId];

      if (existing && existing.checksum !== params.checksum) {
        return { acquired: false, reason: "checksum-mismatch", record: existing };
      }

      if (existing) {
        const leaseExpired = Date.parse(existing.leaseExpiresAt) <= nowMs;
        if (existing.status === "launched" || existing.status === "acked") {
          return { acquired: false, reason: "already-launched", record: existing };
        }
        if (existing.status === "launching" && !leaseExpired) {
          return { acquired: false, reason: "lease-active", record: existing };
        }
      }

      const leaseId = newLeaseId();
      const leaseExpiresAt = new Date(Date.now() + params.leaseTtlSeconds * 1000).toISOString();
      const leaseSequence = (existing?.leaseSequence ?? 0) + 1;
      const record: LaunchRecord = {
        checkpointId: params.checkpointId,
        checksum: params.checksum,
        sourceSessionId: params.sourceSessionId,
        sourceSessionFile: params.sourceSessionFile,
        targetSessionId: null,
        leaseId,
        leaseSequence,
        leaseExpiresAt,
        status: "launching",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: params.expiresAt,
        error: null,
      };
      state.launches[params.checkpointId] = record;
      return { acquired: true, reason: null, record };
    });
  }

  async markLaunchLaunched(
    checkpointId: string,
    leaseId: string,
    targetSessionId: string | null,
  ): Promise<LaunchTransitionResult> {
    return this.update((state) => {
      const existing = state.launches[checkpointId];
      if (!existing) {
        return { updated: false, reason: "missing", record: null };
      }
      if (existing.leaseId !== leaseId) {
        return { updated: false, reason: "lease-mismatch", record: existing };
      }
      if (Date.parse(existing.leaseExpiresAt) <= Date.now()) {
        return { updated: false, reason: "lease-expired", record: existing };
      }
      if (existing.status !== "launching") {
        return { updated: false, reason: "status-mismatch", record: existing };
      }

      const record: LaunchRecord = {
        ...existing,
        status: "launched",
        targetSessionId,
        updatedAt: nowIso(),
        error: null,
      };
      state.launches[checkpointId] = record;
      return { updated: true, reason: null, record };
    });
  }

  async markLaunchFailed(checkpointId: string, leaseId: string, error: string): Promise<LaunchTransitionResult> {
    return this.update((state) => {
      const existing = state.launches[checkpointId];
      if (!existing) {
        return { updated: false, reason: "missing", record: null };
      }
      if (existing.leaseId !== leaseId) {
        return { updated: false, reason: "lease-mismatch", record: existing };
      }
      if (existing.status !== "launching") {
        return { updated: false, reason: "status-mismatch", record: existing };
      }

      const record: LaunchRecord = {
        ...existing,
        status: "failed",
        updatedAt: nowIso(),
        error,
      };
      state.launches[checkpointId] = record;
      return { updated: true, reason: null, record };
    });
  }

  async markLaunchAcked(
    checkpointId: string,
    leaseId: string,
    targetSessionId: string,
    checksum: string,
  ): Promise<LaunchTransitionResult> {
    return this.update((state) => {
      const existing = state.launches[checkpointId];
      if (!existing) {
        return { updated: false, reason: "missing", record: null };
      }
      if (existing.leaseId !== leaseId) {
        return { updated: false, reason: "lease-mismatch", record: existing };
      }
      if (existing.status !== "launched") {
        return { updated: false, reason: "status-mismatch", record: existing };
      }
      if (existing.targetSessionId !== targetSessionId) {
        return { updated: false, reason: "target-session-mismatch", record: existing };
      }
      if (existing.checksum !== checksum) {
        return { updated: false, reason: "checksum-mismatch", record: existing };
      }

      const record: LaunchRecord = {
        ...existing,
        status: "acked",
        updatedAt: nowIso(),
        error: null,
      };
      state.launches[checkpointId] = record;
      return { updated: true, reason: null, record };
    });
  }

  async getLaunch(checkpointId: string): Promise<LaunchRecord | null> {
    const state = await this.readState();
    return state.launches[checkpointId] ?? null;
  }

  async getPendingLaunchForTargetSession(targetSessionId: string): Promise<LaunchRecord | null> {
    const state = await this.readState();
    const matches = Object.values(state.launches)
      .filter((record) => record.targetSessionId === targetSessionId)
      .filter((record) => record.status === "launched" || record.status === "launching")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return matches[0] ?? null;
  }

  async isSessionAcked(targetSessionId: string): Promise<boolean> {
    const state = await this.readState();
    return Object.values(state.launches).some(
      (record) => record.targetSessionId === targetSessionId && record.status === "acked",
    );
  }

  async latestPreparedCheckpointId(sourceSessionId: string): Promise<string | null> {
    const state = await this.readState();
    const match = Object.values(state.launches)
      .filter((record) => record.sourceSessionId === sourceSessionId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    return match?.checkpointId ?? null;
  }

  async latestPreparedLaunch(sourceSessionId: string): Promise<LaunchRecord | null> {
    const state = await this.readState();
    const match = Object.values(state.launches)
      .filter((record) => record.sourceSessionId === sourceSessionId)
      .filter((record) => record.status === "prepared")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    return match ?? null;
  }

  async setThresholdStage(sessionId: string, stage: ThresholdStage): Promise<void> {
    await this.update((state) => {
      state.thresholdStageBySession[sessionId] = stage;
    });
  }

  async getThresholdStage(sessionId: string): Promise<ThresholdStage | undefined> {
    const state = await this.readState();
    return state.thresholdStageBySession[sessionId];
  }

  async getCommandHistory(): Promise<CommandRunMetadata[]> {
    const state = await this.readState();
    return state.commandHistory;
  }
}
