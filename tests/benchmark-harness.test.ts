import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  sha256ForString,
  stableStringify,
  summarizeRawSessionFile,
} from "../scripts/benchmark-harness-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const requiredModel = {
  provider: "example-provider",
  id: "example-model",
  route: "example-route",
};

function runNode(args: string[], env: Record<string, string | undefined> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const processEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete processEnv[key];
    } else {
      processEnv[key] = value;
    }
  }

  const result = spawnSync("node", args, {
    cwd: repoRoot,
    env: processEnv,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function outputText(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function usage() {
  return {
    input: 120,
    output: 32,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 152,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createSessionBuilder(sessionId: string, cwd: string) {
  const rows: Array<Record<string, unknown>> = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: iso(0),
      cwd,
    },
  ];
  const entryIds: string[] = [];
  let nextId = 1;

  const push = (entry: Record<string, unknown>) => {
    const entryId = `${sessionId.slice(0, 4)}${String(nextId).padStart(4, "0")}`;
    const parentId = entryIds.at(-1) ?? null;
    rows.push({
      ...entry,
      id: entryId,
      parentId,
      timestamp: iso(nextId),
    });
    entryIds.push(entryId);
    nextId += 1;
    return entryId;
  };

  return {
    rows,
    addUser(content: string) {
      push({
        type: "message",
        message: {
          role: "user",
          content,
          timestamp: Date.now(),
        },
      });
    },
    addAssistant(text: string) {
      push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-responses",
          provider: requiredModel.provider,
          model: requiredModel.id,
          usage: usage(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
    },
    addVisibleCustomMessage(content: string) {
      push({
        type: "custom_message",
        customType: "fresh-session-handoff",
        content,
        display: true,
      });
    },
    addCompaction(summary: string, tokensBefore: number) {
      const firstKeptEntryId = entryIds[0] ?? null;
      push({
        type: "compaction",
        summary,
        tokensBefore,
        firstKeptEntryId,
      });
    },
  };
}

async function writeJsonl(filePath: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function buildCheckpoint(args: {
  runId: string;
  checkpointId: string;
  checksum: string;
  sourceSessionId: string;
  sequence: number;
  statusDigest: string;
  protectedPathsDigest: string;
}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    protocol: "fresh-session-handoff",
    checkpointId: args.checkpointId,
    sequence: args.sequence,
    createdAt: iso(args.sequence + 10),
    expiresAt: iso(args.sequence + 100),
    checksum: args.checksum,
    session: {
      sessionId: args.sourceSessionId,
      sessionFile: `/tmp/${args.runId}/${args.sourceSessionId}.jsonl`,
      leafId: `leaf-${args.sequence}`,
      parentSession: null,
    },
    model: requiredModel,
    git: {
      branch: "main",
      commit: `commit-${args.runId}-${args.sequence}`,
    },
    criticalFacts: {
      requiredModelProvider: requiredModel.provider,
      requiredModelId: requiredModel.id,
      requiredModelRoute: requiredModel.route,
      statusDigest: args.statusDigest,
      protectedPathsDigest: args.protectedPathsDigest,
    },
  };
}

async function createRunBundle(rawRoot: string, benchmarkKind: string, runNumber: number): Promise<void> {
  const runId = `${benchmarkKind}-run-${runNumber}`;
  const sourceSessionId = `${benchmarkKind}-source-${runNumber}`;
  const handoffTargetOne = `${benchmarkKind}-handoff-${runNumber}-1`;
  const handoffTargetTwo = `${benchmarkKind}-handoff-${runNumber}-2`;
  const checkpointIdOne = `${sourceSessionId}:leaf-1:1`;
  const checkpointIdTwo = `${sourceSessionId}:leaf-2:2`;
  const checkpointChecksumOne = sha256ForString(`checkpoint:${runId}:1`);
  const checkpointChecksumTwo = sha256ForString(`checkpoint:${runId}:2`);
  const statusDigestOne = sha256ForString(`status:${runId}:1`);
  const statusDigestTwo = sha256ForString(`status:${runId}:2`);
  const protectedPathsDigest = sha256ForString(`protected:${runId}`);
  const runDir = path.join(rawRoot, `${benchmarkKind}-${runNumber}`);
  const sessionsDir = path.join(runDir, "sessions");
  const checkpointsDir = path.join(runDir, "checkpoints");

  await mkdir(sessionsDir, { recursive: true });
  await mkdir(checkpointsDir, { recursive: true });

  const sourceSession = createSessionBuilder(sourceSessionId, `/tmp/${runId}`);
  sourceSession.addUser("phase 1");
  sourceSession.addAssistant(`SOURCE_${runId}_PHASE_1_READY`);
  sourceSession.addUser("prepare checkpoint one");
  sourceSession.addAssistant(`SOURCE_${runId}_PHASE_2_READY`);
  if (benchmarkKind === "normal-compaction") {
    sourceSession.addCompaction(`Compaction summary for ${runId}`, 4200);
  }
  sourceSession.addUser("prepare checkpoint two");

  const handoffOne = createSessionBuilder(handoffTargetOne, `/tmp/${runId}`);
  handoffOne.addVisibleCustomMessage("Fresh session handoff is active.");
  handoffOne.addUser(`/fresh-handoff-ack ${checkpointIdOne}`);
  handoffOne.addUser("edit src/main.ts");
  handoffOne.addAssistant(`HANDOFF_ONE_${runId}_EDITED`);

  const handoffTwo = createSessionBuilder(handoffTargetTwo, `/tmp/${runId}`);
  handoffTwo.addVisibleCustomMessage("Fresh session handoff is active.");
  handoffTwo.addUser(`/fresh-handoff-ack ${checkpointIdTwo}`);
  handoffTwo.addUser("edit src/main.ts again");
  handoffTwo.addAssistant(`HANDOFF_TWO_${runId}_EDITED`);

  const sourceSessionPath = path.join(sessionsDir, "source-session.jsonl");
  const handoffOnePath = path.join(sessionsDir, "handoff-1-session.jsonl");
  const handoffTwoPath = path.join(sessionsDir, "handoff-2-session.jsonl");

  await writeJsonl(sourceSessionPath, sourceSession.rows);
  await writeJsonl(handoffOnePath, handoffOne.rows);
  await writeJsonl(handoffTwoPath, handoffTwo.rows);

  const sourceSummary = await summarizeRawSessionFile(sourceSessionPath, sourceSessionId, `${runId} source`);
  const handoffOneSummary = await summarizeRawSessionFile(handoffOnePath, handoffTargetOne, `${runId} handoff one`);
  const handoffTwoSummary = await summarizeRawSessionFile(handoffTwoPath, handoffTargetTwo, `${runId} handoff two`);

  const checkpointOne = buildCheckpoint({
    runId,
    checkpointId: checkpointIdOne,
    checksum: checkpointChecksumOne,
    sourceSessionId,
    sequence: 1,
    statusDigest: statusDigestOne,
    protectedPathsDigest,
  });
  const checkpointTwo = buildCheckpoint({
    runId,
    checkpointId: checkpointIdTwo,
    checksum: checkpointChecksumTwo,
    sourceSessionId,
    sequence: 2,
    statusDigest: statusDigestTwo,
    protectedPathsDigest,
  });

  await writeFile(path.join(checkpointsDir, "checkpoint-1.json"), `${JSON.stringify(checkpointOne, null, 2)}\n`, "utf8");
  await writeFile(path.join(checkpointsDir, "checkpoint-2.json"), `${JSON.stringify(checkpointTwo, null, 2)}\n`, "utf8");

  const ackEntries = [
    {
      checkpointId: checkpointIdOne,
      checksum: checkpointChecksumOne,
      targetSessionId: handoffTargetOne,
      leaseId: `${runId}-lease-1`,
      facts: {
        requiredModelProvider: requiredModel.provider,
        requiredModelId: requiredModel.id,
        requiredModelRoute: requiredModel.route,
        statusDigest: statusDigestOne,
        protectedPathsDigest,
      },
    },
    {
      checkpointId: checkpointIdTwo,
      checksum: checkpointChecksumTwo,
      targetSessionId: handoffTargetTwo,
      leaseId: `${runId}-lease-2`,
      facts: {
        requiredModelProvider: requiredModel.provider,
        requiredModelId: requiredModel.id,
        requiredModelRoute: requiredModel.route,
        statusDigest: statusDigestTwo,
        protectedPathsDigest,
      },
    },
  ];

  await writeFile(path.join(runDir, "acks.json"), `${JSON.stringify({ schemaVersion: "1", acks: ackEntries }, null, 2)}\n`, "utf8");

  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [
    {
      eventType: "checkpoint_prepared",
      payload: {
        runId,
        benchmarkKind,
        checkpointId: checkpointIdOne,
        checksum: checkpointChecksumOne,
        sourceSessionId,
        model: requiredModel,
        statusDigest: statusDigestOne,
        protectedPathsDigest,
        sequence: 1,
        durationMs: 12,
        checkpointFile: "checkpoints/checkpoint-1.json",
      },
    },
    {
      eventType: "fresh_handoff_acked",
      payload: {
        handoffIndex: 1,
        sourceSessionId,
        targetSessionId: handoffTargetOne,
        ackSessionId: handoffTargetOne,
        checkpointId: checkpointIdOne,
        checksum: checkpointChecksumOne,
        leaseId: `${runId}-lease-1`,
        outcome: "acked",
        visibleResponseCount: handoffOneSummary.visibleResponseCount,
        visibleResponseSha256: handoffOneSummary.lastAssistantTextSha256,
        ackDurationMs: 18,
        responseDurationMs: 25,
      },
    },
  ];

  if (benchmarkKind === "normal-compaction") {
    events.push({
      eventType: "manual_compaction_outcome",
      payload: {
        sourceSessionId,
        status: "completed",
        reason: "manual",
        durationMs: 31,
        tokensBefore: 4200,
        estimatedTokensAfter: 900,
      },
    });
  }

  events.push(
    {
      eventType: "checkpoint_prepared",
      payload: {
        runId,
        benchmarkKind,
        checkpointId: checkpointIdTwo,
        checksum: checkpointChecksumTwo,
        sourceSessionId,
        model: requiredModel,
        statusDigest: statusDigestTwo,
        protectedPathsDigest,
        sequence: 2,
        durationMs: 14,
        checkpointFile: "checkpoints/checkpoint-2.json",
      },
    },
    {
      eventType: "stale_checkpoint_outcome",
      payload: {
        status: "blocked",
        checkpointId: checkpointIdOne,
        durationMs: 9,
        reason: "sequence-advanced",
      },
    },
    {
      eventType: "fresh_handoff_acked",
      payload: {
        handoffIndex: 2,
        sourceSessionId,
        targetSessionId: handoffTargetTwo,
        ackSessionId: handoffTargetTwo,
        checkpointId: checkpointIdTwo,
        checksum: checkpointChecksumTwo,
        leaseId: `${runId}-lease-2`,
        outcome: "acked",
        visibleResponseCount: handoffTwoSummary.visibleResponseCount,
        visibleResponseSha256: handoffTwoSummary.lastAssistantTextSha256,
        ackDurationMs: 19,
        responseDurationMs: 26,
      },
    },
    {
      eventType: "duplicate_launch_outcome",
      payload: {
        status: "blocked",
        checkpointId: checkpointIdTwo,
        durationMs: 11,
        reason: "already-launched",
      },
    },
    {
      eventType: "raw_pi_session_hash",
      payload: {
        path: "sessions/source-session.jsonl",
        sessionId: sourceSessionId,
        role: "source",
        sha256: sourceSummary.sha256,
        eventCount: sourceSummary.eventCount,
        visibleResponseCount: sourceSummary.visibleResponseCount,
        lastAssistantTextSha256: sourceSummary.lastAssistantTextSha256,
        lastVisibleTextSha256: sourceSummary.lastVisibleTextSha256,
      },
    },
    {
      eventType: "raw_pi_session_hash",
      payload: {
        path: "sessions/handoff-1-session.jsonl",
        sessionId: handoffTargetOne,
        role: "handoff",
        handoffIndex: 1,
        sha256: handoffOneSummary.sha256,
        eventCount: handoffOneSummary.eventCount,
        visibleResponseCount: handoffOneSummary.visibleResponseCount,
        lastAssistantTextSha256: handoffOneSummary.lastAssistantTextSha256,
        lastVisibleTextSha256: handoffOneSummary.lastVisibleTextSha256,
      },
    },
    {
      eventType: "raw_pi_session_hash",
      payload: {
        path: "sessions/handoff-2-session.jsonl",
        sessionId: handoffTargetTwo,
        role: "handoff",
        handoffIndex: 2,
        sha256: handoffTwoSummary.sha256,
        eventCount: handoffTwoSummary.eventCount,
        visibleResponseCount: handoffTwoSummary.visibleResponseCount,
        lastAssistantTextSha256: handoffTwoSummary.lastAssistantTextSha256,
        lastVisibleTextSha256: handoffTwoSummary.lastVisibleTextSha256,
      },
    },
  );

  const chainedEvents = events.map((event, index) => {
    const previousHash = index === 0 ? "sha256:genesis" : (events[index - 1] as Record<string, unknown>).hash;
    const hashable = {
      index: index + 1,
      eventType: event.eventType,
      payload: event.payload,
      prevHash: previousHash,
    };
    const hash = sha256ForString(stableStringify(hashable));
    const output = { ...hashable, hash };
    (events[index] as Record<string, unknown>).hash = hash;
    return output;
  });

  await writeJsonl(path.join(runDir, "events.jsonl"), chainedEvents as Array<Record<string, unknown>>);

  const runBundle = {
    schemaVersion: "2",
    benchmarkKind,
    runId,
    checkpointFiles: [
      { handoffIndex: 1, path: "checkpoints/checkpoint-1.json" },
      { handoffIndex: 2, path: "checkpoints/checkpoint-2.json" },
    ],
    ackFile: "acks.json",
    eventChainFile: "events.jsonl",
    rawPiSessionFiles: [
      {
        role: "source",
        path: "sessions/source-session.jsonl",
        sessionId: sourceSessionId,
      },
      {
        role: "handoff",
        path: "sessions/handoff-1-session.jsonl",
        sessionId: handoffTargetOne,
        handoffIndex: 1,
        checkpointId: checkpointIdOne,
      },
      {
        role: "handoff",
        path: "sessions/handoff-2-session.jsonl",
        sessionId: handoffTargetTwo,
        handoffIndex: 2,
        checkpointId: checkpointIdTwo,
      },
    ],
  };

  await writeFile(path.join(runDir, "run-bundle.json"), `${JSON.stringify(runBundle, null, 2)}\n`, "utf8");
}

async function createValidRawBenchmarkSet(rawRoot: string): Promise<void> {
  const benchmarkKinds = ["normal-compaction", "fresh-session-handoff"];
  for (const benchmarkKind of benchmarkKinds) {
    for (let runNumber = 1; runNumber <= 2; runNumber += 1) {
      await createRunBundle(rawRoot, benchmarkKind, runNumber);
    }
  }
}

async function createRepoSandbox(prefix: string): Promise<string> {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const sandbox = path.join(repoRoot, ".tmp", path.basename(temp));
  await mkdir(path.dirname(sandbox), { recursive: true });
  await rm(sandbox, { recursive: true, force: true });
  await mkdir(sandbox, { recursive: true });
  return sandbox;
}

describe("benchmark harness", () => {
  it("runner and gate cross-validate valid raw benchmark bundles", async () => {
    const sandbox = await createRepoSandbox("benchmark-harness-pass-");

    try {
      const rawRoot = path.join(sandbox, "raw");
      const resultsRoot = path.join(sandbox, "results");
      await mkdir(rawRoot, { recursive: true });
      await createValidRawBenchmarkSet(rawRoot);

      const runner = runNode([
        "scripts/benchmark-runner.mjs",
        "--raw-root",
        rawRoot,
        "--results-root",
        resultsRoot,
      ]);
      expect(runner.status).toBe(0);
      expect(outputText(runner)).toContain("benchmark runner wrote 4 run results");

      const gate = runNode(["scripts/gate.mjs"], {
        FSH_BENCHMARK_RESULTS_DIR: resultsRoot,
      });
      expect(gate.status).toBe(0);
      expect(outputText(gate)).toContain("gate passed");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("gate rejects tampered benchmark result summaries", async () => {
    const sandbox = await createRepoSandbox("benchmark-harness-tamper-");

    try {
      const rawRoot = path.join(sandbox, "raw");
      const resultsRoot = path.join(sandbox, "results");
      await mkdir(rawRoot, { recursive: true });
      await createValidRawBenchmarkSet(rawRoot);

      const runner = runNode([
        "scripts/benchmark-runner.mjs",
        "--raw-root",
        rawRoot,
        "--results-root",
        resultsRoot,
      ]);
      expect(runner.status).toBe(0);

      const tamperedResultPath = path.join(resultsRoot, "runs", "normal-compaction", "normal-compaction-run-1.json");
      const tamperedResult = JSON.parse(await readFile(tamperedResultPath, "utf8")) as Record<string, unknown>;
      const summary = tamperedResult.summary as Record<string, unknown>;
      const handoffs = summary.handoffs as Array<Record<string, unknown>>;
      handoffs[0] = {
        ...handoffs[0],
        leaseId: "tampered-lease-id",
      };
      summary.handoffs = handoffs;
      tamperedResult.summary = summary;
      await writeFile(tamperedResultPath, `${JSON.stringify(tamperedResult, null, 2)}\n`, "utf8");

      const gate = runNode(["scripts/gate.mjs"], {
        FSH_BENCHMARK_RESULTS_DIR: resultsRoot,
      });
      expect(gate.status).not.toBe(0);
      expect(outputText(gate)).toContain("summary payload mismatch");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("gate rejects schema-shaped fake evidence without raw benchmark bundles", async () => {
    const sandbox = await createRepoSandbox("benchmark-harness-fake-");

    try {
      const resultsRoot = path.join(sandbox, "results");
      const rawRoot = path.join(sandbox, "raw");
      await mkdir(resultsRoot, { recursive: true });
      await mkdir(rawRoot, { recursive: true });

      const benchmarkKinds = ["normal-compaction", "fresh-session-handoff"];

      for (const benchmarkKind of benchmarkKinds) {
        const runs: Array<Record<string, unknown>> = [];

        for (let runNumber = 1; runNumber <= 2; runNumber += 1) {
          const runId = `${benchmarkKind}-fake-${runNumber}`;
          const rawRunDir = path.join(rawRoot, runId);
          await mkdir(rawRunDir, { recursive: true });

          const rawRunDirRelative = path.relative(repoRoot, rawRunDir).split(path.sep).join("/");
          const resultFile = `runs/${benchmarkKind}/${runId}.json`;
          const resultPath = path.join(resultsRoot, resultFile);
          await mkdir(path.dirname(resultPath), { recursive: true });

          const summaryHash = sha256ForString(`${benchmarkKind}:${runId}:summary`);
          const fakeResult = {
            schemaVersion: "2",
            benchmarkKind,
            runId,
            rawRunDir: rawRunDirRelative,
            summaryHash,
            summary: {
              benchmarkKind,
              runId,
              handoffCount: 2,
              outcomes: {
                duplicateLaunch: "blocked",
                staleCheckpoint: "blocked",
              },
              eventChain: {
                finalHash: sha256ForString(`${runId}:event`),
              },
            },
          };

          await writeFile(resultPath, `${JSON.stringify(fakeResult, null, 2)}\n`, "utf8");

          runs.push({
            runId,
            resultFile,
            rawRunDir: rawRunDirRelative,
            summaryHash,
            handoffCount: 2,
            eventFinalHash: sha256ForString(`${runId}:event`),
            duplicateOutcome: "blocked",
            staleOutcome: "blocked",
          });
        }

        const evidence = {
          schemaVersion: "2",
          benchmarkKind,
          runs,
        };

        await writeFile(path.join(resultsRoot, `${benchmarkKind}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      }

      const gate = runNode(["scripts/gate.mjs"], {
        FSH_BENCHMARK_RESULTS_DIR: resultsRoot,
      });

      expect(gate.status).not.toBe(0);
      expect(outputText(gate)).toContain("run-bundle.json");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
