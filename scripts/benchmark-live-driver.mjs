import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createBenchmarkRpcClient, findNotificationMessage, notificationMessages, requiredModel } from "./benchmark-live-rpc.mjs";
import { loadBenchmarkSchema, sha256ForString, stableStringify, summarizeRawSessionFile } from "./benchmark-harness-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const defaultExtensionPath = path.join(homedir(), ".pi", "agent", "extensions", "fresh-session-handoff");
const fixtureCreateScript = path.join(repoRoot, "fixtures", "repeatable-project", "create-fixture.mjs");
const installScript = path.join(repoRoot, "scripts", "install-extension.mjs");
const checkpointStoreRelativeDir = path.join(".pi", "fresh-session-handoff", "checkpoints");
const stateFileRelativePath = path.join(".pi", "fresh-session-handoff", "state.json");
const mainFileRelativePath = path.join("src", "main.ts");
const baseMainLine = 'export const fixture = "fresh-session-handoff";';

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function timestampTag() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\./g, "");
}

function parseArgs(argv) {
  const parsed = {
    rawRoot: undefined,
    schemaPath: undefined,
    runCount: undefined,
    benchmarkKinds: [],
    extensionPath: undefined,
    batchTag: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--raw-root") {
      parsed.rawRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--schema") {
      parsed.schemaPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--run-count") {
      parsed.runCount = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--kind" || token === "--kinds") {
      const kinds = String(argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      parsed.benchmarkKinds.push(...kinds);
      index += 1;
      continue;
    }
    if (token === "--extension") {
      parsed.extensionPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--batch-tag") {
      parsed.batchTag = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${token}`);
  }

  return parsed;
}

function lastNonEmptyLine(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? null;
}

function runNodeScript(scriptPath, args = []) {
  const result = spawnSync("node", [scriptPath, ...args], {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.relative(repoRoot, scriptPath)} failed:\n${result.stdout}\n${result.stderr}`);
  }

  return `${result.stdout}${result.stderr}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, rows) {
  const content = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(filePath, content, "utf8");
}

async function safeList(dirPath) {
  try {
    return await readdir(dirPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listFileSet(dirPath) {
  return new Set(await safeList(dirPath));
}

async function newestNewFile(dirPath, beforeNames, label) {
  const names = (await safeList(dirPath)).filter((name) => !beforeNames.has(name));
  if (names.length === 0) {
    throw new Error(`no new ${label} found in ${dirPath}`);
  }

  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      mtimeMs: (await stat(path.join(dirPath, name))).mtimeMs,
    })),
  );
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return path.join(dirPath, entries[0].name);
}

function assertSelectedModel(model, label) {
  if (!model || typeof model !== "object") {
    throw new Error(`${label} model is missing`);
  }

  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : "";
  const route = typeof model.route === "string" ? model.route : null;
  if (provider !== requiredModel.provider || id !== requiredModel.id) {
    throw new Error(`${label} model must be ${requiredModel.provider}/${requiredModel.id}`);
  }
  if (route !== null && route !== requiredModel.route) {
    throw new Error(`${label} model route must be ${requiredModel.route}`);
  }
  if (id === "forbidden-model" || id === "example-provider/forbidden-model") {
    throw new Error(`${label} model must never substitute forbidden-model`);
  }
}

function assertCheckpointModel(checkpoint, label) {
  const model = checkpoint?.model ?? {};
  const facts = checkpoint?.criticalFacts ?? {};
  if (
    model.provider !== requiredModel.provider ||
    model.id !== requiredModel.id ||
    model.route !== requiredModel.route
  ) {
    throw new Error(`${label} checkpoint model mismatch`);
  }
  if (
    facts.requiredModelProvider !== requiredModel.provider ||
    facts.requiredModelId !== requiredModel.id ||
    facts.requiredModelRoute !== requiredModel.route
  ) {
    throw new Error(`${label} checkpoint critical facts model mismatch`);
  }
}

function expectedHandoffLine(runId, handoffIndex) {
  if (handoffIndex === 1) {
    return `export const handoffOneMarker = "${runId}-handoff-1";`;
  }
  return `export const handoffTwoMarker = "${runId}-handoff-2";`;
}

function sourcePhasePrompt(runId, phaseNumber) {
  return `Reply with SOURCE_${runId.replace(/[^A-Za-z0-9]/g, "_")}_PHASE_${phaseNumber}_READY only.`;
}

function editPrompt(runId, handoffIndex) {
  const line = expectedHandoffLine(runId, handoffIndex);
  const reply = handoffIndex === 1 ? "HANDOFF_ONE_EDITED" : "HANDOFF_TWO_EDITED";
  return [
    "Read src/main.ts.",
    "Preserve every existing export line already in the file.",
    `Append exactly one new line at the end: ${line}`,
    "Do not modify any other file.",
    "Do not touch protected paths.",
    "Use the edit tool or the write tool, not bash.",
    `When the file is correct, reply with ${reply} only.`,
  ].join(" ");
}

function compactionInstructions(runId) {
  return `Preserve the benchmark phase markers and handoff checkpoints for ${runId}.`;
}

async function assertMainFileContains(filePath, expectedLines) {
  const content = await readFile(filePath, "utf8");
  for (const line of expectedLines) {
    if (!content.includes(line)) {
      throw new Error(`expected ${path.basename(filePath)} to contain: ${line}`);
    }
  }
}

async function createBaseFixture() {
  const output = runNodeScript(fixtureCreateScript);
  const projectDir = lastNonEmptyLine(output);
  if (!projectDir) {
    throw new Error("fixture create script did not print a project path");
  }
  return projectDir;
}

async function installExtension() {
  runNodeScript(installScript);
}

async function sessionFilesById(sessionDir) {
  const map = new Map();
  for (const entry of await safeList(sessionDir)) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(sessionDir, entry);
    const content = await readFile(filePath, "utf8");
    const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) {
      continue;
    }
    const parsed = JSON.parse(firstLine);
    if (parsed && typeof parsed.id === "string") {
      map.set(parsed.id, filePath);
    }
  }
  return map;
}

async function readLaunchRecord(stateFilePath, checkpointId) {
  const state = await readJson(stateFilePath);
  return state?.launches?.[checkpointId] ?? null;
}

function buildAckPayload(checkpoint, launchRecord) {
  return {
    checkpointId: checkpoint.checkpointId,
    checksum: checkpoint.checksum,
    targetSessionId: launchRecord.targetSessionId,
    leaseId: launchRecord.leaseId,
    facts: checkpoint.criticalFacts,
  };
}

function requireNotification(records, pattern, label) {
  const match = findNotificationMessage(records, pattern);
  if (!match) {
    const seen = notificationMessages(records).map((record) => `${record.level}:${record.message}`).join(" | ");
    throw new Error(`${label} notification missing (${pattern}). seen=${seen}`);
  }
  return match.message;
}

function duplicateReasonFromMessage(message) {
  const match = message.match(/reason=([^\s]+)/);
  return match?.[1] ?? message;
}

function staleReasonFromMessage(message) {
  const staleMatch = message.match(/Checkpoint is stale:\s*(.*)$/i);
  if (staleMatch?.[1]) {
    return staleMatch[1];
  }

  const factsMatch = message.match(/Checkpoint runtime facts changed:\s*(.*)$/i);
  if (factsMatch?.[1]) {
    return `runtime-facts-changed:${factsMatch[1]}`;
  }

  return message;
}

function buildHashChainedEvents(events) {
  const chained = [];
  let previousHash = "sha256:genesis";

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const hashable = {
      index: index + 1,
      eventType: event.eventType,
      payload: event.payload,
      prevHash: previousHash,
    };
    const hash = sha256ForString(stableStringify(hashable));
    chained.push({ ...hashable, hash });
    previousHash = hash;
  }

  return chained;
}

async function openBenchmarkSession({ cwd, sessionDir, extensionPath, session, name }) {
  const rpc = createBenchmarkRpcClient({
    cwd,
    sessionDir,
    extensionPath,
    noExtensions: false,
    session,
    name,
  });
  await rpc.waitForIdle({ timeoutMs: 30000, pollMs: 100 });
  const state = await rpc.getState();
  assertSelectedModel(state?.model, name ?? "benchmark session");
  await rpc.setAutoCompaction(false);
  return { rpc, state: await rpc.getState() };
}

async function prepareCheckpoint(rpc, checkpointDir, knownCheckpointNames, label) {
  const result = await rpc.promptAndWait("/fresh-handoff-prepare");
  const checkpointPath = await newestNewFile(checkpointDir, knownCheckpointNames, `${label} checkpoint`);
  knownCheckpointNames.add(path.basename(checkpointPath));
  const checkpoint = await readJson(checkpointPath);
  assertCheckpointModel(checkpoint, label);
  return { result, checkpointPath, checkpoint };
}

async function launchCheckpoint(rpc, checkpoint, stateFilePath, label) {
  const result = await rpc.promptAndWait(`/fresh-handoff-launch ${checkpoint.checkpointId}`);
  assertSelectedModel(result.state?.model, `${label} launched session`);
  const launchRecord = await readLaunchRecord(stateFilePath, checkpoint.checkpointId);
  if (!launchRecord || launchRecord.status !== "launched" || typeof launchRecord.targetSessionId !== "string") {
    throw new Error(`${label} launch did not reach launched state`);
  }
  if (launchRecord.checkpointId !== checkpoint.checkpointId || launchRecord.checksum !== checkpoint.checksum) {
    throw new Error(`${label} launch record checkpoint mismatch`);
  }
  if (result.state?.sessionId !== launchRecord.targetSessionId) {
    throw new Error(`${label} launch switched to unexpected session`);
  }
  return { result, launchRecord };
}

async function ackAndEdit({
  rpc,
  checkpoint,
  launchRecord,
  stateFilePath,
  runId,
  handoffIndex,
  mainFilePath,
  expectedLines,
}) {
  const ackPayload = buildAckPayload(checkpoint, launchRecord);
  const ackResult = await rpc.promptAndWait(`/fresh-handoff-ack ${JSON.stringify(ackPayload)}`);
  requireNotification(ackResult.records, /Ack verified\. Editing tools are enabled\./i, `handoff ${handoffIndex} ack`);

  const launchAfterAck = await readLaunchRecord(stateFilePath, checkpoint.checkpointId);
  if (
    !launchAfterAck ||
    launchAfterAck.status !== "acked" ||
    launchAfterAck.leaseId !== launchRecord.leaseId ||
    launchAfterAck.targetSessionId !== launchRecord.targetSessionId
  ) {
    throw new Error(`handoff ${handoffIndex} ack did not persist acked launch state`);
  }

  const editResult = await rpc.promptAndWait(editPrompt(runId, handoffIndex), {
    idleTimeoutMs: 240000,
  });
  const responseText = await rpc.getLastAssistantText({ timeoutMs: 30000 });
  if (typeof responseText !== "string" || responseText.trim().length === 0) {
    throw new Error(`handoff ${handoffIndex} did not produce a visible assistant response`);
  }

  await assertMainFileContains(mainFilePath, expectedLines);

  return {
    ackPayload,
    ackResult,
    editResult,
    responseText: responseText.trim(),
  };
}

async function copySessionArtifact(sessionPath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sessionPath, destinationPath, { force: true });
}

async function executeLiveRun({
  rawRoot,
  extensionPath,
  benchmarkKind,
  runNumber,
  batchTag,
  baseFixturePath,
}) {
  const runId = `${benchmarkKind}-${batchTag}-run-${runNumber}`;
  const runDir = path.join(rawRoot, runId);
  const workspaceDir = path.join(runDir, "workspace");
  const runtimeSessionDir = path.join(runDir, "runtime-sessions");
  const normalizedSessionsDir = path.join(runDir, "sessions");
  const normalizedCheckpointsDir = path.join(runDir, "checkpoints");
  const checkpointDir = path.join(workspaceDir, checkpointStoreRelativeDir);
  const stateFilePath = path.join(workspaceDir, stateFileRelativePath);
  const mainFilePath = path.join(workspaceDir, mainFileRelativePath);
  const clients = [];

  await mkdir(runDir, { recursive: false });
  await mkdir(runtimeSessionDir, { recursive: true });
  await cp(baseFixturePath, workspaceDir, { recursive: true, force: false, errorOnExist: true });

  const knownCheckpointNames = await listFileSet(checkpointDir);

  try {
    const sourceSession = await openBenchmarkSession({
      cwd: workspaceDir,
      sessionDir: runtimeSessionDir,
      extensionPath,
      name: `${runId}-source`,
    });
    clients.push(sourceSession.rpc);

    const sourceSessionId = sourceSession.state.sessionId;
    const sourceSessionFile = sourceSession.state.sessionFile;
    if (typeof sourceSessionFile !== "string" || sourceSessionFile.trim().length === 0) {
      throw new Error(`${runId} source session file is missing`);
    }

    await sourceSession.rpc.promptAndWait(sourcePhasePrompt(runId, 1));

    const checkpointOne = await prepareCheckpoint(sourceSession.rpc, checkpointDir, knownCheckpointNames, "handoff one");
    const launchOne = await launchCheckpoint(sourceSession.rpc, checkpointOne.checkpoint, stateFilePath, "handoff one");
    const expectedLineOne = expectedHandoffLine(runId, 1);
    const handoffOne = await ackAndEdit({
      rpc: sourceSession.rpc,
      checkpoint: checkpointOne.checkpoint,
      launchRecord: launchOne.launchRecord,
      stateFilePath,
      runId,
      handoffIndex: 1,
      mainFilePath,
      expectedLines: [baseMainLine, expectedLineOne],
    });

    const resumedSource = await openBenchmarkSession({
      cwd: workspaceDir,
      sessionDir: runtimeSessionDir,
      extensionPath,
      session: sourceSessionFile,
      name: `${runId}-source-phase-2`,
    });
    clients.push(resumedSource.rpc);

    let compaction = null;
    if (benchmarkKind === "normal-compaction") {
      const compactionResult = await resumedSource.rpc.compactAndWait(compactionInstructions(runId), {
        idleTimeoutMs: 240000,
      });
      const compactionData = compactionResult.response.data ?? {};
      compaction = {
        durationMs: compactionResult.durationMs,
        tokensBefore: typeof compactionData.tokensBefore === "number" ? compactionData.tokensBefore : 0,
        estimatedTokensAfter:
          typeof compactionData.estimatedTokensAfter === "number" ? compactionData.estimatedTokensAfter : 0,
      };
    }

    await resumedSource.rpc.promptAndWait(sourcePhasePrompt(runId, 2));

    const checkpointTwo = await prepareCheckpoint(resumedSource.rpc, checkpointDir, knownCheckpointNames, "handoff two");

    const staleAttempt = await resumedSource.rpc.promptAndWait(`/fresh-handoff-launch ${checkpointOne.checkpoint.checkpointId}`);
    const staleMessage = requireNotification(
      staleAttempt.records,
      /Checkpoint is stale:|Checkpoint runtime facts changed:/i,
      `${runId} stale checkpoint`,
    );

    const launchTwo = await launchCheckpoint(resumedSource.rpc, checkpointTwo.checkpoint, stateFilePath, "handoff two");
    const expectedLineTwo = expectedHandoffLine(runId, 2);
    const handoffTwo = await ackAndEdit({
      rpc: resumedSource.rpc,
      checkpoint: checkpointTwo.checkpoint,
      launchRecord: launchTwo.launchRecord,
      stateFilePath,
      runId,
      handoffIndex: 2,
      mainFilePath,
      expectedLines: [baseMainLine, expectedLineOne, expectedLineTwo],
    });

    const duplicateSource = await openBenchmarkSession({
      cwd: workspaceDir,
      sessionDir: runtimeSessionDir,
      extensionPath,
      session: sourceSessionFile,
      name: `${runId}-duplicate-check`,
    });
    clients.push(duplicateSource.rpc);

    const duplicateAttempt = await duplicateSource.rpc.promptAndWait(`/fresh-handoff-launch ${checkpointTwo.checkpoint.checkpointId}`);
    const duplicateMessage = requireNotification(
      duplicateAttempt.records,
      /launch deduped .*reason=already-launched/i,
      `${runId} duplicate launch`,
    );

    const sessionIdToOriginalPath = await sessionFilesById(runtimeSessionDir);
    const normalizedSessionFiles = [
      {
        role: "source",
        sessionId: sourceSessionId,
        sourcePath: sessionIdToOriginalPath.get(sourceSessionId),
        destinationPath: path.join(normalizedSessionsDir, "source-session.jsonl"),
      },
      {
        role: "handoff",
        handoffIndex: 1,
        checkpointId: checkpointOne.checkpoint.checkpointId,
        sessionId: launchOne.launchRecord.targetSessionId,
        sourcePath: sessionIdToOriginalPath.get(launchOne.launchRecord.targetSessionId),
        destinationPath: path.join(normalizedSessionsDir, "handoff-1-session.jsonl"),
      },
      {
        role: "handoff",
        handoffIndex: 2,
        checkpointId: checkpointTwo.checkpoint.checkpointId,
        sessionId: launchTwo.launchRecord.targetSessionId,
        sourcePath: sessionIdToOriginalPath.get(launchTwo.launchRecord.targetSessionId),
        destinationPath: path.join(normalizedSessionsDir, "handoff-2-session.jsonl"),
      },
    ];

    for (const sessionFile of normalizedSessionFiles) {
      if (typeof sessionFile.sourcePath !== "string") {
        throw new Error(`missing runtime session file for ${sessionFile.sessionId}`);
      }
      await copySessionArtifact(sessionFile.sourcePath, sessionFile.destinationPath);
    }

    const checkpointFiles = [
      {
        handoffIndex: 1,
        checkpoint: checkpointOne.checkpoint,
        sourcePath: checkpointOne.checkpointPath,
        destinationPath: path.join(normalizedCheckpointsDir, "checkpoint-1.json"),
      },
      {
        handoffIndex: 2,
        checkpoint: checkpointTwo.checkpoint,
        sourcePath: checkpointTwo.checkpointPath,
        destinationPath: path.join(normalizedCheckpointsDir, "checkpoint-2.json"),
      },
    ];

    for (const checkpointFile of checkpointFiles) {
      await copySessionArtifact(checkpointFile.sourcePath, checkpointFile.destinationPath);
    }

    const copiedStatePath = path.join(runDir, "state.json");
    await copySessionArtifact(stateFilePath, copiedStatePath);

    const ackDocument = {
      schemaVersion: "1",
      acks: [handoffOne.ackPayload, handoffTwo.ackPayload],
    };
    const ackPath = path.join(runDir, "acks.json");
    await writeJson(ackPath, ackDocument);

    const sessionSummaries = [];
    for (const sessionFile of normalizedSessionFiles) {
      const summary = await summarizeRawSessionFile(
        sessionFile.destinationPath,
        sessionFile.sessionId,
        `${runId} ${sessionFile.role} session`,
      );
      sessionSummaries.push({
        role: sessionFile.role,
        handoffIndex: sessionFile.handoffIndex,
        checkpointId: sessionFile.checkpointId,
        path: toPosixPath(path.relative(runDir, sessionFile.destinationPath)),
        sessionId: sessionFile.sessionId,
        ...summary,
      });
    }

    const sessionSummaryByPath = new Map(sessionSummaries.map((summary) => [summary.path, summary]));
    const handoffOneSummary = sessionSummaryByPath.get("sessions/handoff-1-session.jsonl");
    const handoffTwoSummary = sessionSummaryByPath.get("sessions/handoff-2-session.jsonl");
    if (!handoffOneSummary || !handoffTwoSummary) {
      throw new Error(`${runId} handoff session summaries are incomplete`);
    }

    const events = [];
    events.push({
      eventType: "checkpoint_prepared",
      payload: {
        runId,
        benchmarkKind,
        checkpointId: checkpointOne.checkpoint.checkpointId,
        checksum: checkpointOne.checkpoint.checksum,
        sourceSessionId,
        model: requiredModel,
        statusDigest: checkpointOne.checkpoint.criticalFacts.statusDigest,
        protectedPathsDigest: checkpointOne.checkpoint.criticalFacts.protectedPathsDigest,
        sequence: checkpointOne.checkpoint.sequence,
        durationMs: checkpointOne.result.durationMs,
        checkpointFile: "checkpoints/checkpoint-1.json",
      },
    });
    events.push({
      eventType: "fresh_handoff_acked",
      payload: {
        handoffIndex: 1,
        sourceSessionId,
        targetSessionId: launchOne.launchRecord.targetSessionId,
        ackSessionId: launchOne.launchRecord.targetSessionId,
        checkpointId: checkpointOne.checkpoint.checkpointId,
        checksum: checkpointOne.checkpoint.checksum,
        leaseId: launchOne.launchRecord.leaseId,
        outcome: "acked",
        visibleResponseCount: handoffOneSummary.visibleResponseCount,
        visibleResponseSha256: handoffOneSummary.lastAssistantTextSha256,
        ackDurationMs: handoffOne.ackResult.durationMs,
        responseDurationMs: handoffOne.editResult.durationMs,
      },
    });
    if (compaction) {
      events.push({
        eventType: "manual_compaction_outcome",
        payload: {
          sourceSessionId,
          status: "completed",
          reason: "manual",
          durationMs: compaction.durationMs,
          tokensBefore: compaction.tokensBefore,
          estimatedTokensAfter: compaction.estimatedTokensAfter,
        },
      });
    }
    events.push({
      eventType: "checkpoint_prepared",
      payload: {
        runId,
        benchmarkKind,
        checkpointId: checkpointTwo.checkpoint.checkpointId,
        checksum: checkpointTwo.checkpoint.checksum,
        sourceSessionId,
        model: requiredModel,
        statusDigest: checkpointTwo.checkpoint.criticalFacts.statusDigest,
        protectedPathsDigest: checkpointTwo.checkpoint.criticalFacts.protectedPathsDigest,
        sequence: checkpointTwo.checkpoint.sequence,
        durationMs: checkpointTwo.result.durationMs,
        checkpointFile: "checkpoints/checkpoint-2.json",
      },
    });
    events.push({
      eventType: "stale_checkpoint_outcome",
      payload: {
        status: "blocked",
        checkpointId: checkpointOne.checkpoint.checkpointId,
        durationMs: staleAttempt.durationMs,
        reason: staleReasonFromMessage(staleMessage),
      },
    });
    events.push({
      eventType: "fresh_handoff_acked",
      payload: {
        handoffIndex: 2,
        sourceSessionId,
        targetSessionId: launchTwo.launchRecord.targetSessionId,
        ackSessionId: launchTwo.launchRecord.targetSessionId,
        checkpointId: checkpointTwo.checkpoint.checkpointId,
        checksum: checkpointTwo.checkpoint.checksum,
        leaseId: launchTwo.launchRecord.leaseId,
        outcome: "acked",
        visibleResponseCount: handoffTwoSummary.visibleResponseCount,
        visibleResponseSha256: handoffTwoSummary.lastAssistantTextSha256,
        ackDurationMs: handoffTwo.ackResult.durationMs,
        responseDurationMs: handoffTwo.editResult.durationMs,
      },
    });
    events.push({
      eventType: "duplicate_launch_outcome",
      payload: {
        status: "blocked",
        checkpointId: checkpointTwo.checkpoint.checkpointId,
        durationMs: duplicateAttempt.durationMs,
        reason: duplicateReasonFromMessage(duplicateMessage),
      },
    });

    for (const sessionSummary of sessionSummaries) {
      events.push({
        eventType: "raw_pi_session_hash",
        payload: {
          path: sessionSummary.path,
          sessionId: sessionSummary.sessionId,
          role: sessionSummary.role,
          handoffIndex: sessionSummary.handoffIndex,
          sha256: sessionSummary.sha256,
          eventCount: sessionSummary.eventCount,
          visibleResponseCount: sessionSummary.visibleResponseCount,
          lastAssistantTextSha256: sessionSummary.lastAssistantTextSha256,
          lastVisibleTextSha256: sessionSummary.lastVisibleTextSha256,
        },
      });
    }

    const chainedEvents = buildHashChainedEvents(events);
    await writeJsonl(path.join(runDir, "events.jsonl"), chainedEvents);

    const driverMetadata = {
      runId,
      benchmarkKind,
      workspaceDir: "workspace",
      runtimeSessionDir: "runtime-sessions",
      sourceSessionId,
      sourceSessionFile: toPosixPath(path.relative(runDir, sourceSessionFile)),
      checkpoints: checkpointFiles.map((entry) => ({
        handoffIndex: entry.handoffIndex,
        checkpointId: entry.checkpoint.checkpointId,
        checksum: entry.checkpoint.checksum,
        sequence: entry.checkpoint.sequence,
        checkpointFile: toPosixPath(path.relative(runDir, entry.destinationPath)),
        statusDigest: entry.checkpoint.criticalFacts.statusDigest,
        protectedPathsDigest: entry.checkpoint.criticalFacts.protectedPathsDigest,
      })),
      handoffs: [
        {
          handoffIndex: 1,
          targetSessionId: launchOne.launchRecord.targetSessionId,
          leaseId: launchOne.launchRecord.leaseId,
          visibleResponse: handoffOne.responseText,
          ackDurationMs: handoffOne.ackResult.durationMs,
          responseDurationMs: handoffOne.editResult.durationMs,
          expectedLine: expectedLineOne,
        },
        {
          handoffIndex: 2,
          targetSessionId: launchTwo.launchRecord.targetSessionId,
          leaseId: launchTwo.launchRecord.leaseId,
          visibleResponse: handoffTwo.responseText,
          ackDurationMs: handoffTwo.ackResult.durationMs,
          responseDurationMs: handoffTwo.editResult.durationMs,
          expectedLine: expectedLineTwo,
        },
      ],
      compaction,
      duplicateLaunch: {
        status: "blocked",
        message: duplicateMessage,
        durationMs: duplicateAttempt.durationMs,
      },
      staleCheckpoint: {
        status: "blocked",
        message: staleMessage,
        durationMs: staleAttempt.durationMs,
      },
    };
    await writeJson(path.join(runDir, "driver-metadata.json"), driverMetadata);

    const runBundle = {
      schemaVersion: "2",
      benchmarkKind,
      runId,
      checkpointFiles: checkpointFiles.map((entry) => ({
        handoffIndex: entry.handoffIndex,
        path: toPosixPath(path.relative(runDir, entry.destinationPath)),
      })),
      ackFile: "acks.json",
      eventChainFile: "events.jsonl",
      rawPiSessionFiles: normalizedSessionFiles.map((entry) => ({
        role: entry.role,
        path: toPosixPath(path.relative(runDir, entry.destinationPath)),
        sessionId: entry.sessionId,
        handoffIndex: entry.handoffIndex,
        checkpointId: entry.checkpointId,
      })),
      stateFile: "state.json",
      driverMetadataFile: "driver-metadata.json",
      workspaceDir: "workspace",
    };
    await writeJson(path.join(runDir, "run-bundle.json"), runBundle);

    return {
      runId,
      benchmarkKind,
      runDir,
    };
  } catch (error) {
    await writeFile(path.join(runDir, "driver-error.txt"), `${String(error)}\n`, "utf8");
    throw error;
  } finally {
    for (const client of clients.reverse()) {
      await client.close().catch(() => undefined);
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const schemaPath = path.resolve(repoRoot, args.schemaPath ?? process.env.FSH_BENCHMARK_SCHEMA_PATH ?? "docs/benchmark-evidence.schema.json");
  const rawRoot = path.resolve(repoRoot, args.rawRoot ?? process.env.FSH_BENCHMARK_RAW_ROOT ?? path.join("benchmark-results", "raw"));
  const extensionPath = path.resolve(args.extensionPath ?? process.env.FSH_BENCHMARK_EXTENSION_PATH ?? defaultExtensionPath);
  const schema = await loadBenchmarkSchema(schemaPath);
  const benchmarkKinds = args.benchmarkKinds.length > 0 ? args.benchmarkKinds : schema.requiredBenchmarkKinds;
  const runCount = args.runCount ?? schema.requiredRunCountPerKind;
  const batchTag = args.batchTag ?? timestampTag();

  if (!Number.isInteger(runCount) || runCount <= 0) {
    throw new Error("--run-count must be a positive integer");
  }

  for (const kind of benchmarkKinds) {
    if (!schema.requiredBenchmarkKinds.includes(kind)) {
      throw new Error(`unknown benchmark kind ${kind}`);
    }
  }

  await mkdir(rawRoot, { recursive: true });
  await installExtension();
  const baseFixturePath = await createBaseFixture();

  const completedRuns = [];
  for (const benchmarkKind of benchmarkKinds) {
    for (let runNumber = 1; runNumber <= runCount; runNumber += 1) {
      const result = await executeLiveRun({
        rawRoot,
        extensionPath,
        benchmarkKind,
        runNumber,
        batchTag,
        baseFixturePath,
      });
      completedRuns.push({
        runId: result.runId,
        benchmarkKind: result.benchmarkKind,
        rawRunDir: toPosixPath(path.relative(repoRoot, result.runDir)),
      });
      console.log(`completed ${result.runId}`);
    }
  }

  console.log(JSON.stringify({ batchTag, rawRoot: toPosixPath(path.relative(repoRoot, rawRoot)), completedRuns }, null, 2));
}

run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
