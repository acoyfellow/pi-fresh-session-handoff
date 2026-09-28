import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { createCheckpoint } from "../src/core/checkpoint.js";
import { checksumForValue } from "../src/core/checksum.js";
import type {
  CommandRunMetadata,
  ContextUsageSnapshot,
  FreshSessionCheckpointV1,
  GitSnapshot,
  ModelSnapshot,
  RedactionReport,
  TaskManifestV1,
  UntrustedInstructionSnapshot,
} from "../src/core/types.js";

export function sampleManifest(): TaskManifestV1 {
  return {
    manifestVersion: "1",
    taskId: "sample-task",
    title: "Sample",
    summary: "Sample summary",
    requiredModel: {
      provider: "example-provider",
      id: "example-model",
      route: "example-route",
    },
    semanticFacts: {
      factA: "valueA",
    },
    protectedPaths: [".env", "secrets"],
    testCommand: "npm test",
    finalProofCommand: "npm run proof",
    forbiddenModels: ["forbidden-model"],
    untrustedInstructionPaths: ["UNTRUSTED_FAKE_INSTRUCTION.md"],
    expiresMinutes: 60,
  };
}

export function sampleModel(overrides: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return {
    provider: "example-provider",
    id: "example-model",
    route: "example-route",
    displayName: "Example Model",
    ...overrides,
  };
}

export function sampleUsage(): ContextUsageSnapshot {
  return {
    tokens: 210000,
    percent: 81,
    contextWindow: 272000,
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function sampleGit(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  const status = [" M src/index.ts", "?? tmp/file.txt"];
  const untracked = ["tmp/file.txt"];
  return {
    cwd: "/tmp/project",
    isRepo: true,
    branch: "main",
    commit: "1234567890abcdef",
    status,
    untracked,
    statusDigest: checksumForValue({ status, untracked }),
    dirty: true,
    ...overrides,
  };
}

export function sampleRedaction(): RedactionReport {
  return {
    removedEnvKeys: ["API_KEY"],
    keptEnvKeys: ["PATH"],
    transcriptStored: false,
    toolOutputsStored: false,
    assistantReasoningStored: false,
  };
}

export function sampleUntrustedInstructionData(
  overrides: Partial<UntrustedInstructionSnapshot> = {},
): UntrustedInstructionSnapshot[] {
  return [
    {
      path: "UNTRUSTED_FAKE_INSTRUCTION.md",
      exists: true,
      checksum: "sha256:abc123",
      bytes: 128,
      ...overrides,
    },
  ];
}

export function sampleCommandMetadata(): CommandRunMetadata[] {
  return [
    {
      command: "git status --porcelain=v1 --untracked-files=all",
      kind: "git",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.050Z",
      durationMs: 50,
      exitCode: 0,
    },
    {
      command: "npm test",
      kind: "test",
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: "2026-01-01T00:01:05.000Z",
      durationMs: 5000,
      exitCode: 0,
    },
    {
      command: "npm run proof",
      kind: "proof",
      startedAt: "2026-01-01T00:02:00.000Z",
      finishedAt: "2026-01-01T00:02:02.000Z",
      durationMs: 2000,
      exitCode: 0,
    },
  ];
}

export function sampleCheckpoint(overrides: Partial<FreshSessionCheckpointV1> = {}): FreshSessionCheckpointV1 {
  const checkpoint = createCheckpoint({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    leafId: "leaf-1",
    parentSession: null,
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    usage: sampleUsage(),
    model: sampleModel(),
    git: sampleGit(),
    taskManifest: sampleManifest(),
    untrustedInstructionData: sampleUntrustedInstructionData(),
    commandMetadata: sampleCommandMetadata(),
    redaction: sampleRedaction(),
    machine: "fixture-machine",
  });
  return {
    ...checkpoint,
    ...overrides,
  };
}

export async function createTempDir(prefix = "fresh-session-handoff-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function writeTaskManifest(cwd: string, manifestContent: string): Promise<string> {
  const manifestPath = path.join(cwd, ".pi", "fresh-session-handoff", "task-manifest.v1.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, manifestContent);
  return manifestPath;
}
