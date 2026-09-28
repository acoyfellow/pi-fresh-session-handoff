import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const genesisHash = "sha256:genesis";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function stableKeySort(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function stableStringify(value) {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const source = value;
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort(stableKeySort);

  const fields = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`);
  return `{${fields.join(",")}}`;
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256ForString(content) {
  return `sha256:${sha256Hex(content)}`;
}

export function sha256ForBuffer(content) {
  return `sha256:${sha256Hex(content)}`;
}

export async function sha256ForFile(filePath) {
  const content = await readFile(filePath);
  return sha256ForBuffer(content);
}

function assertObject(value, name) {
  if (!isObject(value)) {
    throw new Error(`invalid field ${name}`);
  }
  return value;
}

function assertString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid field ${name}`);
  }
  return value.trim();
}

function assertInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`invalid field ${name}`);
  }
  return value;
}

function assertPositiveInteger(value, name) {
  const integer = assertInteger(value, name);
  if (integer <= 0) {
    throw new Error(`invalid field ${name}`);
  }
  return integer;
}

function assertNonNegativeInteger(value, name) {
  const integer = assertInteger(value, name);
  if (integer < 0) {
    throw new Error(`invalid field ${name}`);
  }
  return integer;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`invalid field ${name}`);
  }
  return value;
}

function assertNullableString(value, name) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid field ${name}`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) {
    return null;
  }
  return assertString(value, name);
}

function optionalNonNegativeInteger(value, name) {
  if (value === undefined || value === null) {
    return null;
  }
  return assertNonNegativeInteger(value, name);
}

function assertSha256Digest(value, name) {
  const digest = assertString(value, name);
  if (!sha256Pattern.test(digest)) {
    throw new Error(`invalid sha256 digest ${name}`);
  }
  return digest;
}

function optionalSha256Digest(value, name) {
  if (value === undefined || value === null) {
    return null;
  }
  return assertSha256Digest(value, name);
}

function resolvePathInside(root, requestedPath, name) {
  const relative = assertString(requestedPath, name);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${name} escapes run directory`);
  }
  return {
    absolute,
    relative: toPosixPath(rel),
  };
}

export async function loadJsonFile(filePath, name) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${name} missing: ${String(error)}`);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${name} invalid JSON: ${String(error)}`);
  }
}

export async function loadJsonlFile(filePath, name) {
  const content = await readFile(filePath, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      parsed.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${name} invalid JSONL line ${index + 1}: ${String(error)}`);
    }
  }

  return parsed;
}

function assertModelExact(value, requiredModel, name) {
  const model = assertObject(value, name);
  const provider = assertString(model.provider, `${name}.provider`);
  const id = assertString(model.id, `${name}.id`);
  const route = assertString(model.route, `${name}.route`);

  if (provider !== requiredModel.provider || id !== requiredModel.id || route !== requiredModel.route) {
    throw new Error(`required model mismatch at ${name}`);
  }

  return {
    provider,
    id,
    route,
  };
}

function textFromContentBlocks(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => {
      if (!isObject(entry)) {
        return "";
      }
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function textFromSyntheticVisibleEvent(event) {
  const content = typeof event.content === "string" ? event.content.trim() : "";
  const message = typeof event.message === "string" ? event.message.trim() : "";
  const text = typeof event.text === "string" ? event.text.trim() : "";
  return content || message || text;
}

function summarizeSessionRow(row) {
  if (!isObject(row)) {
    return {
      visibleResponseCount: 0,
      lastVisibleText: null,
      lastAssistantText: null,
      compactionEntryCount: 0,
    };
  }

  if (row.type === "compaction") {
    return {
      visibleResponseCount: 0,
      lastVisibleText: null,
      lastAssistantText: null,
      compactionEntryCount: 1,
    };
  }

  if (row.type === "custom_message" && row.display === true) {
    const text = textFromContentBlocks(row.content);
    return {
      visibleResponseCount: text.length > 0 ? 1 : 0,
      lastVisibleText: text.length > 0 ? text : null,
      lastAssistantText: null,
      compactionEntryCount: 0,
    };
  }

  if (row.type === "message") {
    const message = isObject(row.message) ? row.message : null;
    if (message?.role === "assistant") {
      const text = textFromContentBlocks(message.content);
      return {
        visibleResponseCount: text.length > 0 ? 1 : 0,
        lastVisibleText: text.length > 0 ? text : null,
        lastAssistantText: text.length > 0 ? text : null,
        compactionEntryCount: 0,
      };
    }
  }

  const visible = row.visible === true || row.display === true;
  const text = visible ? textFromSyntheticVisibleEvent(row) : "";
  return {
    visibleResponseCount: text.length > 0 ? 1 : 0,
    lastVisibleText: text.length > 0 ? text : null,
    lastAssistantText: text.length > 0 ? text : null,
    compactionEntryCount: 0,
  };
}

export function summarizeRawSessionEntries(entries, expectedSessionId, name) {
  const sessionId = assertString(expectedSessionId, `${name}.sessionId`);
  const observedSessionIds = new Set();
  let visibleResponseCount = 0;
  let lastVisibleText = null;
  let lastAssistantText = null;
  let compactionEntryCount = 0;

  for (const row of entries) {
    if (!isObject(row)) {
      continue;
    }

    if (typeof row.sessionId === "string" && row.sessionId.trim().length > 0) {
      observedSessionIds.add(row.sessionId.trim());
    }
    if (row.type === "session" && typeof row.id === "string" && row.id.trim().length > 0) {
      observedSessionIds.add(row.id.trim());
    }

    const summary = summarizeSessionRow(row);
    visibleResponseCount += summary.visibleResponseCount;
    compactionEntryCount += summary.compactionEntryCount;
    if (summary.lastVisibleText !== null) {
      lastVisibleText = summary.lastVisibleText;
    }
    if (summary.lastAssistantText !== null) {
      lastAssistantText = summary.lastAssistantText;
    }
  }

  if (!observedSessionIds.has(sessionId)) {
    throw new Error(`${name} does not contain expected sessionId ${sessionId}`);
  }
  if (observedSessionIds.size > 1) {
    throw new Error(`${name} contains mixed sessionIds`);
  }

  return {
    eventCount: entries.length,
    visibleResponseCount,
    lastAssistantTextSha256: lastAssistantText ? sha256ForString(lastAssistantText) : null,
    lastVisibleTextSha256: lastVisibleText ? sha256ForString(lastVisibleText) : null,
    compactionEntryCount,
  };
}

export async function summarizeRawSessionFile(filePath, expectedSessionId, name) {
  const entries = await loadJsonlFile(filePath, name);
  const summary = summarizeRawSessionEntries(entries, expectedSessionId, name);
  return {
    ...summary,
    sha256: await sha256ForFile(filePath),
  };
}

function normalizeEvent(raw, index) {
  const event = assertObject(raw, `events[${index}]`);
  const eventType = assertString(event.eventType, `events[${index}].eventType`);
  const prevHash = assertString(event.prevHash, `events[${index}].prevHash`);
  const hash = assertSha256Digest(event.hash, `events[${index}].hash`);
  const payload = assertObject(event.payload, `events[${index}].payload`);

  return {
    index: index + 1,
    eventType,
    prevHash,
    hash,
    payload,
  };
}

function verifyHashChain(events) {
  const normalizedEvents = events.map((event, index) => normalizeEvent(event, index));
  let expectedPrevHash = genesisHash;

  for (const event of normalizedEvents) {
    if (event.prevHash !== expectedPrevHash) {
      throw new Error(`event hash chain prev mismatch at index ${event.index}`);
    }

    const hashable = {
      index: event.index,
      eventType: event.eventType,
      payload: event.payload,
      prevHash: event.prevHash,
    };

    const expectedHash = sha256ForString(stableStringify(hashable));
    if (event.hash !== expectedHash) {
      throw new Error(`event hash mismatch at index ${event.index}`);
    }

    expectedPrevHash = expectedHash;
  }

  return {
    events: normalizedEvents,
    finalHash: expectedPrevHash,
  };
}

function eventByType(events, eventType) {
  return events.filter((event) => event.eventType === eventType);
}

function normalizeHandoffSummaries(handoffs) {
  return handoffs.sort((a, b) => a.handoffIndex - b.handoffIndex);
}

function normalizeCheckpointSummaries(checkpoints) {
  return checkpoints.sort((a, b) => a.sequence - b.sequence || a.checkpointId.localeCompare(b.checkpointId));
}

function normalizedSessionSort(a, b) {
  if (a.role === b.role) {
    const aIndex = a.handoffIndex ?? 0;
    const bIndex = b.handoffIndex ?? 0;
    return aIndex - bIndex;
  }
  return a.role === "source" ? -1 : 1;
}

export async function loadBenchmarkSchema(schemaPath) {
  const raw = await loadJsonFile(schemaPath, "benchmark schema");
  const source = assertObject(raw, "benchmark schema");

  const schemaVersion = assertString(source.schemaVersion, "schemaVersion");
  const resultFileSchemaVersion = assertString(source.resultFileSchemaVersion, "resultFileSchemaVersion");
  const requiredBenchmarkKinds = assertArray(source.requiredBenchmarkKinds, "requiredBenchmarkKinds").map(
    (entry, index) => assertString(entry, `requiredBenchmarkKinds[${index}]`),
  );

  if (requiredBenchmarkKinds.length === 0) {
    throw new Error("requiredBenchmarkKinds must contain at least one benchmark kind");
  }

  const requiredModelRaw = assertObject(source.requiredModel, "requiredModel");
  const requiredModel = {
    provider: assertString(requiredModelRaw.provider, "requiredModel.provider"),
    id: assertString(requiredModelRaw.id, "requiredModel.id"),
    route: assertString(requiredModelRaw.route, "requiredModel.route"),
  };

  const requiredRunCountPerKind = assertPositiveInteger(source.requiredRunCountPerKind, "requiredRunCountPerKind");
  const requiredHandoffsPerRun = assertPositiveInteger(source.requiredHandoffsPerRun, "requiredHandoffsPerRun");
  const requiredVisibleResponsesPerHandoff = assertPositiveInteger(
    source.requiredVisibleResponsesPerHandoff,
    "requiredVisibleResponsesPerHandoff",
  );

  return {
    schemaVersion,
    resultFileSchemaVersion,
    requiredBenchmarkKinds,
    requiredModel,
    requiredRunCountPerKind,
    requiredHandoffsPerRun,
    requiredVisibleResponsesPerHandoff,
  };
}

function assertBenchmarkKindAllowed(kind, schema) {
  if (!schema.requiredBenchmarkKinds.includes(kind)) {
    throw new Error(`unexpected benchmark kind ${kind}`);
  }
}

function normalizeCheckpointFileReference(entryRaw, index, runDir) {
  if (typeof entryRaw === "string") {
    const resolved = resolvePathInside(runDir, entryRaw, `run bundle.checkpointFiles[${index}]`);
    return {
      absolute: resolved.absolute,
      relative: resolved.relative,
    };
  }

  const entry = assertObject(entryRaw, `run bundle.checkpointFiles[${index}]`);
  const resolved = resolvePathInside(runDir, entry.path, `run bundle.checkpointFiles[${index}].path`);
  return {
    absolute: resolved.absolute,
    relative: resolved.relative,
  };
}

function checkpointFileReferences(bundle, runDir) {
  if (Array.isArray(bundle.checkpointFiles) && bundle.checkpointFiles.length > 0) {
    return bundle.checkpointFiles.map((entry, index) => normalizeCheckpointFileReference(entry, index, runDir));
  }

  if (bundle.checkpointFile !== undefined) {
    const resolved = resolvePathInside(runDir, bundle.checkpointFile, "run bundle.checkpointFile");
    return [
      {
        absolute: resolved.absolute,
        relative: resolved.relative,
      },
    ];
  }

  throw new Error("run bundle must define checkpointFile or checkpointFiles");
}

async function loadCheckpointSummaries(checkpointRefs, schema, expectedSourceSessionId) {
  const byId = new Map();
  const summaries = [];

  for (let index = 0; index < checkpointRefs.length; index += 1) {
    const ref = checkpointRefs[index];
    const checkpointRaw = await loadJsonFile(ref.absolute, `checkpoint file ${ref.relative}`);
    const checkpoint = assertObject(checkpointRaw, `checkpoint file ${ref.relative}`);
    const checkpointId = assertString(checkpoint.checkpointId, `checkpoint file ${ref.relative}.checkpointId`);
    const checkpointChecksum = assertSha256Digest(
      checkpoint.checksum,
      `checkpoint file ${ref.relative}.checksum`,
    );
    const sequence = assertPositiveInteger(checkpoint.sequence, `checkpoint file ${ref.relative}.sequence`);
    const session = assertObject(checkpoint.session, `checkpoint file ${ref.relative}.session`);
    const sourceSessionId = assertString(
      session.sessionId,
      `checkpoint file ${ref.relative}.session.sessionId`,
    );

    if (sourceSessionId !== expectedSourceSessionId) {
      throw new Error(`source sessionId mismatch for checkpoint ${checkpointId}`);
    }

    assertModelExact(checkpoint.model, schema.requiredModel, `checkpoint file ${ref.relative}.model`);

    const facts = assertObject(checkpoint.criticalFacts, `checkpoint file ${ref.relative}.criticalFacts`);
    const requiredModelProvider = assertString(
      facts.requiredModelProvider,
      `checkpoint file ${ref.relative}.criticalFacts.requiredModelProvider`,
    );
    const requiredModelId = assertString(
      facts.requiredModelId,
      `checkpoint file ${ref.relative}.criticalFacts.requiredModelId`,
    );
    const requiredModelRoute = assertString(
      facts.requiredModelRoute,
      `checkpoint file ${ref.relative}.criticalFacts.requiredModelRoute`,
    );
    const statusDigest = assertSha256Digest(
      facts.statusDigest,
      `checkpoint file ${ref.relative}.criticalFacts.statusDigest`,
    );
    const protectedPathsDigest = assertSha256Digest(
      facts.protectedPathsDigest,
      `checkpoint file ${ref.relative}.criticalFacts.protectedPathsDigest`,
    );

    if (requiredModelProvider !== schema.requiredModel.provider) {
      throw new Error(`checkpoint requiredModelProvider mismatch for ${checkpointId}`);
    }
    if (requiredModelId !== schema.requiredModel.id) {
      throw new Error(`checkpoint requiredModelId mismatch for ${checkpointId}`);
    }
    if (requiredModelRoute !== schema.requiredModel.route) {
      throw new Error(`checkpoint requiredModelRoute mismatch for ${checkpointId}`);
    }
    if (byId.has(checkpointId)) {
      throw new Error(`duplicate checkpointId ${checkpointId}`);
    }

    const checkpointGit = assertObject(checkpoint.git, `checkpoint file ${ref.relative}.git`);
    const branch = assertNullableString(checkpointGit.branch, `checkpoint file ${ref.relative}.git.branch`);
    const commit = assertNullableString(checkpointGit.commit, `checkpoint file ${ref.relative}.git.commit`);
    const sha256 = await sha256ForFile(ref.absolute);

    const summary = {
      checkpointId,
      checkpointChecksum,
      sourceSessionId,
      sequence,
      statusDigest,
      protectedPathsDigest,
      branch,
      commit,
      path: ref.relative,
      sha256,
    };

    byId.set(checkpointId, {
      checkpoint,
      summary,
    });
    summaries.push(summary);
  }

  return {
    byId,
    summaries: normalizeCheckpointSummaries(summaries),
  };
}

function parseAckEntries(rawAckDocument, schema, checkpointsById) {
  const ackDocument = assertObject(rawAckDocument, "ack document");
  const ackSchemaVersion = assertString(ackDocument.schemaVersion, "ack document.schemaVersion");
  if (ackSchemaVersion !== "1") {
    throw new Error("ack document schemaVersion must be 1");
  }

  const ackEntries = assertArray(ackDocument.acks, "ack document.acks");
  if (ackEntries.length < schema.requiredHandoffsPerRun) {
    throw new Error("ack document does not contain enough handoff acknowledgements");
  }

  const byTargetSessionId = new Map();

  ackEntries.forEach((entryRaw, index) => {
    const entry = assertObject(entryRaw, `ack document.acks[${index}]`);
    const checkpointId = assertString(entry.checkpointId, `ack document.acks[${index}].checkpointId`);
    const checkpoint = checkpointsById.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`ack references unknown checkpointId ${checkpointId}`);
    }

    const checksum = assertSha256Digest(entry.checksum, `ack document.acks[${index}].checksum`);
    if (checksum !== checkpoint.summary.checkpointChecksum) {
      throw new Error(`ack checksum mismatch for checkpoint ${checkpointId}`);
    }

    const targetSessionId = assertString(entry.targetSessionId, `ack document.acks[${index}].targetSessionId`);
    const leaseId = assertString(entry.leaseId, `ack document.acks[${index}].leaseId`);
    const facts = assertObject(entry.facts, `ack document.acks[${index}].facts`);

    const requiredModelProvider = assertString(
      facts.requiredModelProvider,
      `ack document.acks[${index}].facts.requiredModelProvider`,
    );
    const requiredModelId = assertString(
      facts.requiredModelId,
      `ack document.acks[${index}].facts.requiredModelId`,
    );
    const requiredModelRoute = assertString(
      facts.requiredModelRoute,
      `ack document.acks[${index}].facts.requiredModelRoute`,
    );
    const statusDigest = assertSha256Digest(
      facts.statusDigest,
      `ack document.acks[${index}].facts.statusDigest`,
    );
    const protectedPathsDigest = assertSha256Digest(
      facts.protectedPathsDigest,
      `ack document.acks[${index}].facts.protectedPathsDigest`,
    );

    if (requiredModelProvider !== schema.requiredModel.provider) {
      throw new Error(`ack requiredModelProvider mismatch for target session ${targetSessionId}`);
    }
    if (requiredModelId !== schema.requiredModel.id) {
      throw new Error(`ack requiredModelId mismatch for target session ${targetSessionId}`);
    }
    if (requiredModelRoute !== schema.requiredModel.route) {
      throw new Error(`ack requiredModelRoute mismatch for target session ${targetSessionId}`);
    }
    if (statusDigest !== checkpoint.summary.statusDigest) {
      throw new Error(`ack statusDigest mismatch for target session ${targetSessionId}`);
    }
    if (protectedPathsDigest !== checkpoint.summary.protectedPathsDigest) {
      throw new Error(`ack protectedPathsDigest mismatch for target session ${targetSessionId}`);
    }

    if (byTargetSessionId.has(targetSessionId)) {
      throw new Error(`duplicate ack for target session ${targetSessionId}`);
    }

    byTargetSessionId.set(targetSessionId, {
      targetSessionId,
      leaseId,
      checkpointId,
      checksum,
    });
  });

  return {
    byTargetSessionId,
    count: ackEntries.length,
  };
}

export async function analyzeRawBenchmarkRun(rawRunDir, schema) {
  const runDir = path.resolve(rawRunDir);
  const bundlePath = path.join(runDir, "run-bundle.json");
  await access(bundlePath);

  const bundleRaw = await loadJsonFile(bundlePath, `run bundle ${runDir}`);
  const bundle = assertObject(bundleRaw, "run bundle");

  const bundleSchemaVersion = assertString(bundle.schemaVersion, "run bundle.schemaVersion");
  if (bundleSchemaVersion !== "1" && bundleSchemaVersion !== "2") {
    throw new Error("run bundle schemaVersion must be 1 or 2");
  }

  const benchmarkKind = assertString(bundle.benchmarkKind, "run bundle.benchmarkKind");
  const runId = assertString(bundle.runId, "run bundle.runId");
  assertBenchmarkKindAllowed(benchmarkKind, schema);

  const checkpointRefs = checkpointFileReferences(bundle, runDir);
  const ackFileRef = resolvePathInside(runDir, bundle.ackFile, "run bundle.ackFile");
  const eventChainFileRef = resolvePathInside(runDir, bundle.eventChainFile, "run bundle.eventChainFile");

  const sessionEntriesRaw = assertArray(bundle.rawPiSessionFiles, "run bundle.rawPiSessionFiles");
  const sessionEntries = sessionEntriesRaw.map((entryRaw, index) => {
    const entry = assertObject(entryRaw, `run bundle.rawPiSessionFiles[${index}]`);
    const role = assertString(entry.role, `run bundle.rawPiSessionFiles[${index}].role`);
    if (role !== "source" && role !== "handoff") {
      throw new Error(`invalid rawPiSessionFiles role at index ${index}`);
    }

    const resolvedPath = resolvePathInside(runDir, entry.path, `run bundle.rawPiSessionFiles[${index}].path`);
    const sessionId = assertString(entry.sessionId, `run bundle.rawPiSessionFiles[${index}].sessionId`);
    const handoffIndex =
      role === "handoff"
        ? assertPositiveInteger(entry.handoffIndex, `run bundle.rawPiSessionFiles[${index}].handoffIndex`)
        : undefined;

    return {
      role,
      path: resolvedPath.relative,
      absolutePath: resolvedPath.absolute,
      sessionId,
      handoffIndex,
    };
  });

  const sourceSessions = sessionEntries.filter((entry) => entry.role === "source");
  if (sourceSessions.length !== 1) {
    throw new Error("run bundle must contain exactly one source raw Pi session file");
  }

  const handoffSessions = sessionEntries.filter((entry) => entry.role === "handoff");
  if (handoffSessions.length < schema.requiredHandoffsPerRun) {
    throw new Error("run bundle does not contain enough fresh handoff sessions");
  }

  const sessionSummaries = [];
  for (const entry of sessionEntries) {
    const summary = await summarizeRawSessionFile(entry.absolutePath, entry.sessionId, `raw Pi JSONL ${entry.path}`);
    sessionSummaries.push({
      role: entry.role,
      handoffIndex: entry.handoffIndex,
      path: entry.path,
      sessionId: entry.sessionId,
      ...summary,
    });
  }
  sessionSummaries.sort(normalizedSessionSort);

  const { byId: checkpointsById, summaries: checkpointSummaries } = await loadCheckpointSummaries(
    checkpointRefs,
    schema,
    sourceSessions[0].sessionId,
  );
  if (checkpointSummaries.length === 0) {
    throw new Error("run bundle must contain at least one checkpoint file");
  }

  const ackRaw = await loadJsonFile(ackFileRef.absolute, "ack file");
  const ackEntries = parseAckEntries(ackRaw, schema, checkpointsById);

  const eventChainRaw = await loadJsonlFile(eventChainFileRef.absolute, "event chain");
  if (eventChainRaw.length === 0) {
    throw new Error("event chain is empty");
  }
  const eventChain = verifyHashChain(eventChainRaw);

  const checkpointEvents = eventByType(eventChain.events, "checkpoint_prepared");
  if (checkpointEvents.length === 0) {
    throw new Error("event chain must contain at least one checkpoint_prepared event");
  }

  const checkpointEventById = new Map();
  for (let index = 0; index < checkpointEvents.length; index += 1) {
    const event = checkpointEvents[index];
    const payload = event.payload;
    const eventRunId = assertString(payload.runId, `checkpoint_prepared[${index}].payload.runId`);
    const eventBenchmarkKind = assertString(
      payload.benchmarkKind,
      `checkpoint_prepared[${index}].payload.benchmarkKind`,
    );
    const checkpointId = assertString(payload.checkpointId, `checkpoint_prepared[${index}].payload.checkpointId`);
    const checkpoint = checkpointsById.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`checkpoint_prepared references unknown checkpointId ${checkpointId}`);
    }

    const checksum = assertSha256Digest(payload.checksum, `checkpoint_prepared[${index}].payload.checksum`);
    const sourceSessionId = assertString(
      payload.sourceSessionId,
      `checkpoint_prepared[${index}].payload.sourceSessionId`,
    );
    const statusDigest = assertSha256Digest(
      payload.statusDigest,
      `checkpoint_prepared[${index}].payload.statusDigest`,
    );
    const protectedPathsDigest = assertSha256Digest(
      payload.protectedPathsDigest,
      `checkpoint_prepared[${index}].payload.protectedPathsDigest`,
    );

    if (eventRunId !== runId) {
      throw new Error(`checkpoint_prepared runId mismatch for checkpoint ${checkpointId}`);
    }
    if (eventBenchmarkKind !== benchmarkKind) {
      throw new Error(`checkpoint_prepared benchmarkKind mismatch for checkpoint ${checkpointId}`);
    }
    if (checksum !== checkpoint.summary.checkpointChecksum) {
      throw new Error(`checkpoint_prepared checksum mismatch for checkpoint ${checkpointId}`);
    }
    if (sourceSessionId !== checkpoint.summary.sourceSessionId) {
      throw new Error(`checkpoint_prepared sourceSessionId mismatch for checkpoint ${checkpointId}`);
    }
    if (statusDigest !== checkpoint.summary.statusDigest) {
      throw new Error(`checkpoint_prepared statusDigest mismatch for checkpoint ${checkpointId}`);
    }
    if (protectedPathsDigest !== checkpoint.summary.protectedPathsDigest) {
      throw new Error(`checkpoint_prepared protectedPathsDigest mismatch for checkpoint ${checkpointId}`);
    }
    if (checkpointEventById.has(checkpointId)) {
      throw new Error(`duplicate checkpoint_prepared event for checkpoint ${checkpointId}`);
    }

    assertModelExact(payload.model, schema.requiredModel, `checkpoint_prepared[${index}].payload.model`);

    const sequence = optionalNonNegativeInteger(payload.sequence, `checkpoint_prepared[${index}].payload.sequence`);
    if (sequence !== null && sequence !== checkpoint.summary.sequence) {
      throw new Error(`checkpoint_prepared sequence mismatch for checkpoint ${checkpointId}`);
    }

    const checkpointFilePath = optionalString(
      payload.checkpointFile,
      `checkpoint_prepared[${index}].payload.checkpointFile`,
    );
    if (checkpointFilePath !== null && checkpointFilePath !== checkpoint.summary.path) {
      throw new Error(`checkpoint_prepared checkpointFile mismatch for checkpoint ${checkpointId}`);
    }

    checkpointEventById.set(checkpointId, {
      durationMs: optionalNonNegativeInteger(payload.durationMs, `checkpoint_prepared[${index}].payload.durationMs`),
    });
  }

  for (const checkpoint of checkpointSummaries) {
    if (!checkpointEventById.has(checkpoint.checkpointId)) {
      throw new Error(`missing checkpoint_prepared event for checkpoint ${checkpoint.checkpointId}`);
    }
  }

  const rawSessionHashEvents = eventByType(eventChain.events, "raw_pi_session_hash");
  if (rawSessionHashEvents.length !== sessionSummaries.length) {
    throw new Error("raw_pi_session_hash event count mismatch");
  }

  const rawSessionHashByPath = new Map();
  rawSessionHashEvents.forEach((event, index) => {
    const payload = event.payload;
    const payloadPath = assertString(payload.path, `raw_pi_session_hash[${index}].payload.path`);
    if (rawSessionHashByPath.has(payloadPath)) {
      throw new Error(`duplicate raw_pi_session_hash payload.path ${payloadPath}`);
    }
    rawSessionHashByPath.set(payloadPath, event);
  });

  for (const summary of sessionSummaries) {
    const event = rawSessionHashByPath.get(summary.path);
    if (!event) {
      throw new Error(`missing raw_pi_session_hash event for ${summary.path}`);
    }

    const payload = event.payload;
    const payloadSessionId = assertString(payload.sessionId, `raw_pi_session_hash payload sessionId for ${summary.path}`);
    const payloadRole = assertString(payload.role, `raw_pi_session_hash payload role for ${summary.path}`);
    const payloadSha256 = assertSha256Digest(payload.sha256, `raw_pi_session_hash payload sha256 for ${summary.path}`);
    const payloadEventCount = assertPositiveInteger(
      payload.eventCount,
      `raw_pi_session_hash payload eventCount for ${summary.path}`,
    );
    const payloadVisibleResponseCount = assertInteger(
      payload.visibleResponseCount,
      `raw_pi_session_hash payload visibleResponseCount for ${summary.path}`,
    );

    if (payloadSessionId !== summary.sessionId) {
      throw new Error(`raw_pi_session_hash sessionId mismatch for ${summary.path}`);
    }
    if (payloadRole !== summary.role) {
      throw new Error(`raw_pi_session_hash role mismatch for ${summary.path}`);
    }
    if (payloadSha256 !== summary.sha256) {
      throw new Error(`raw_pi_session_hash sha256 mismatch for ${summary.path}`);
    }
    if (payloadEventCount !== summary.eventCount) {
      throw new Error(`raw_pi_session_hash eventCount mismatch for ${summary.path}`);
    }
    if (payloadVisibleResponseCount !== summary.visibleResponseCount) {
      throw new Error(`raw_pi_session_hash visibleResponseCount mismatch for ${summary.path}`);
    }

    const payloadLastAssistantTextSha256 = optionalSha256Digest(
      payload.lastAssistantTextSha256,
      `raw_pi_session_hash payload lastAssistantTextSha256 for ${summary.path}`,
    );
    if (payloadLastAssistantTextSha256 !== null && payloadLastAssistantTextSha256 !== summary.lastAssistantTextSha256) {
      throw new Error(`raw_pi_session_hash lastAssistantTextSha256 mismatch for ${summary.path}`);
    }

    const payloadLastVisibleTextSha256 = optionalSha256Digest(
      payload.lastVisibleTextSha256,
      `raw_pi_session_hash payload lastVisibleTextSha256 for ${summary.path}`,
    );
    if (payloadLastVisibleTextSha256 !== null && payloadLastVisibleTextSha256 !== summary.lastVisibleTextSha256) {
      throw new Error(`raw_pi_session_hash lastVisibleTextSha256 mismatch for ${summary.path}`);
    }

    if (summary.role === "handoff") {
      const payloadHandoffIndex = assertPositiveInteger(
        payload.handoffIndex,
        `raw_pi_session_hash payload handoffIndex for ${summary.path}`,
      );
      if (payloadHandoffIndex !== summary.handoffIndex) {
        throw new Error(`raw_pi_session_hash handoffIndex mismatch for ${summary.path}`);
      }
    }
  }

  const handoffAckEvents = eventByType(eventChain.events, "fresh_handoff_acked");
  if (handoffAckEvents.length !== handoffSessions.length) {
    throw new Error("fresh_handoff_acked event count mismatch");
  }
  if (handoffAckEvents.length < schema.requiredHandoffsPerRun) {
    throw new Error("fresh_handoff_acked event count below required handoff count");
  }

  const handoffSessionByIndex = new Map();
  for (const session of handoffSessions) {
    if (handoffSessionByIndex.has(session.handoffIndex)) {
      throw new Error(`duplicate handoffIndex in run bundle ${session.handoffIndex}`);
    }
    handoffSessionByIndex.set(session.handoffIndex, session);
  }

  const handoffSummaries = [];
  for (let index = 0; index < handoffAckEvents.length; index += 1) {
    const event = handoffAckEvents[index];
    const payload = event.payload;

    const handoffIndex = assertPositiveInteger(payload.handoffIndex, `fresh_handoff_acked[${index}].payload.handoffIndex`);
    const checkpointId = assertString(payload.checkpointId, `fresh_handoff_acked[${index}].payload.checkpointId`);
    const checkpoint = checkpointsById.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`fresh_handoff_acked references unknown checkpointId ${checkpointId}`);
    }

    const eventSourceSessionId = assertString(
      payload.sourceSessionId,
      `fresh_handoff_acked[${index}].payload.sourceSessionId`,
    );
    const targetSessionId = assertString(payload.targetSessionId, `fresh_handoff_acked[${index}].payload.targetSessionId`);
    const ackSessionId = assertString(payload.ackSessionId, `fresh_handoff_acked[${index}].payload.ackSessionId`);
    const checksum = assertSha256Digest(payload.checksum, `fresh_handoff_acked[${index}].payload.checksum`);
    const leaseId = assertString(payload.leaseId, `fresh_handoff_acked[${index}].payload.leaseId`);
    const outcome = assertString(payload.outcome, `fresh_handoff_acked[${index}].payload.outcome`);
    const visibleResponseCount = assertPositiveInteger(
      payload.visibleResponseCount,
      `fresh_handoff_acked[${index}].payload.visibleResponseCount`,
    );

    if (eventSourceSessionId !== checkpoint.summary.sourceSessionId) {
      throw new Error(`fresh_handoff_acked sourceSessionId mismatch for handoff ${handoffIndex}`);
    }
    if (ackSessionId !== targetSessionId) {
      throw new Error(`fresh_handoff_acked ackSessionId mismatch for handoff ${handoffIndex}`);
    }
    if (checksum !== checkpoint.summary.checkpointChecksum) {
      throw new Error(`fresh_handoff_acked checksum mismatch for handoff ${handoffIndex}`);
    }
    if (outcome !== "acked") {
      throw new Error(`fresh_handoff_acked outcome mismatch for handoff ${handoffIndex}`);
    }

    const handoffSession = handoffSessionByIndex.get(handoffIndex);
    if (!handoffSession) {
      throw new Error(`fresh_handoff_acked references unknown handoffIndex ${handoffIndex}`);
    }
    if (handoffSession.sessionId !== targetSessionId) {
      throw new Error(`fresh_handoff_acked targetSessionId mismatch for handoff ${handoffIndex}`);
    }

    const sessionSummary = sessionSummaries.find((summary) => summary.path === handoffSession.path);
    if (!sessionSummary) {
      throw new Error(`missing session summary for handoff ${handoffIndex}`);
    }
    if (sessionSummary.visibleResponseCount < schema.requiredVisibleResponsesPerHandoff) {
      throw new Error(`handoff ${handoffIndex} does not contain enough visible assistant responses`);
    }
    if (sessionSummary.visibleResponseCount !== visibleResponseCount) {
      throw new Error(`fresh_handoff_acked visibleResponseCount mismatch for handoff ${handoffIndex}`);
    }

    const visibleResponseSha256 = optionalSha256Digest(
      payload.visibleResponseSha256,
      `fresh_handoff_acked[${index}].payload.visibleResponseSha256`,
    );
    if (visibleResponseSha256 !== null && visibleResponseSha256 !== sessionSummary.lastAssistantTextSha256) {
      throw new Error(`fresh_handoff_acked visibleResponseSha256 mismatch for handoff ${handoffIndex}`);
    }

    const ackEntry = ackEntries.byTargetSessionId.get(targetSessionId);
    if (!ackEntry) {
      throw new Error(`missing ack entry for handoff targetSessionId ${targetSessionId}`);
    }
    if (ackEntry.leaseId !== leaseId) {
      throw new Error(`leaseId mismatch for handoff targetSessionId ${targetSessionId}`);
    }
    if (ackEntry.checkpointId !== checkpointId) {
      throw new Error(`ack checkpointId mismatch for handoff targetSessionId ${targetSessionId}`);
    }

    handoffSummaries.push({
      handoffIndex,
      checkpointId,
      checkpointChecksum: checksum,
      targetSessionId,
      ackSessionId,
      leaseId,
      visibleResponseCount,
      visibleResponseSha256: sessionSummary.lastAssistantTextSha256,
      ackDurationMs: optionalNonNegativeInteger(
        payload.ackDurationMs,
        `fresh_handoff_acked[${index}].payload.ackDurationMs`,
      ),
      responseDurationMs: optionalNonNegativeInteger(
        payload.responseDurationMs,
        `fresh_handoff_acked[${index}].payload.responseDurationMs`,
      ),
      rawPiSessionPath: handoffSession.path,
      rawPiSessionSha256: sessionSummary.sha256,
    });
  }

  const distinctCheckpointIds = new Set(handoffSummaries.map((summary) => summary.checkpointId));
  if (distinctCheckpointIds.size < schema.requiredHandoffsPerRun) {
    throw new Error("fresh handoff runs must use distinct checkpoints for each handoff session");
  }

  if (ackEntries.byTargetSessionId.size !== handoffSessions.length) {
    throw new Error("ack document handoff count mismatch");
  }

  const duplicateEvents = eventByType(eventChain.events, "duplicate_launch_outcome");
  if (duplicateEvents.length !== 1) {
    throw new Error("event chain must contain exactly one duplicate_launch_outcome event");
  }
  const duplicateOutcome = assertString(duplicateEvents[0].payload.status, "duplicate_launch_outcome.payload.status");
  if (duplicateOutcome !== "blocked") {
    throw new Error("duplicate_launch_outcome must be blocked");
  }
  const duplicateDetails = {
    checkpointId: optionalString(duplicateEvents[0].payload.checkpointId, "duplicate_launch_outcome.payload.checkpointId"),
    durationMs: optionalNonNegativeInteger(
      duplicateEvents[0].payload.durationMs,
      "duplicate_launch_outcome.payload.durationMs",
    ),
    reason: optionalString(duplicateEvents[0].payload.reason, "duplicate_launch_outcome.payload.reason"),
  };

  const staleEvents = eventByType(eventChain.events, "stale_checkpoint_outcome");
  if (staleEvents.length !== 1) {
    throw new Error("event chain must contain exactly one stale_checkpoint_outcome event");
  }
  const staleOutcome = assertString(staleEvents[0].payload.status, "stale_checkpoint_outcome.payload.status");
  if (staleOutcome !== "blocked") {
    throw new Error("stale_checkpoint_outcome must be blocked");
  }
  const staleDetails = {
    checkpointId: optionalString(staleEvents[0].payload.checkpointId, "stale_checkpoint_outcome.payload.checkpointId"),
    durationMs: optionalNonNegativeInteger(
      staleEvents[0].payload.durationMs,
      "stale_checkpoint_outcome.payload.durationMs",
    ),
    reason: optionalString(staleEvents[0].payload.reason, "stale_checkpoint_outcome.payload.reason"),
  };

  const compactionEvents = eventByType(eventChain.events, "manual_compaction_outcome");
  const compactions = compactionEvents.map((event, index) => {
    const payload = event.payload;
    const sourceSessionId = assertString(
      payload.sourceSessionId,
      `manual_compaction_outcome[${index}].payload.sourceSessionId`,
    );
    const status = assertString(payload.status, `manual_compaction_outcome[${index}].payload.status`);
    const reason = assertString(payload.reason, `manual_compaction_outcome[${index}].payload.reason`);

    if (sourceSessionId !== sourceSessions[0].sessionId) {
      throw new Error(`manual_compaction_outcome sourceSessionId mismatch at index ${index}`);
    }
    if (status !== "completed") {
      throw new Error(`manual_compaction_outcome must be completed at index ${index}`);
    }
    if (reason !== "manual") {
      throw new Error(`manual_compaction_outcome reason must be manual at index ${index}`);
    }

    return {
      sourceSessionId,
      status,
      reason,
      durationMs: optionalNonNegativeInteger(payload.durationMs, `manual_compaction_outcome[${index}].payload.durationMs`),
      tokensBefore: optionalNonNegativeInteger(payload.tokensBefore, `manual_compaction_outcome[${index}].payload.tokensBefore`),
      estimatedTokensAfter: optionalNonNegativeInteger(
        payload.estimatedTokensAfter,
        `manual_compaction_outcome[${index}].payload.estimatedTokensAfter`,
      ),
    };
  });

  if (benchmarkKind === "normal-compaction" && compactions.length === 0) {
    throw new Error("normal-compaction runs must include manual_compaction_outcome evidence");
  }

  const eventChainFileSha256 = await sha256ForFile(eventChainFileRef.absolute);
  const ackFileSha256 = await sha256ForFile(ackFileRef.absolute);

  const summary = {
    benchmarkKind,
    runId,
    sourceSessionId: sourceSessions[0].sessionId,
    checkpointCount: checkpointSummaries.length,
    checkpoints: checkpointSummaries.map((checkpoint) => ({
      ...checkpoint,
      preparedDurationMs: checkpointEventById.get(checkpoint.checkpointId)?.durationMs ?? null,
    })),
    handoffCount: handoffSummaries.length,
    handoffs: normalizeHandoffSummaries(handoffSummaries),
    model: {
      provider: schema.requiredModel.provider,
      id: schema.requiredModel.id,
      route: schema.requiredModel.route,
    },
    outcomes: {
      duplicateLaunch: duplicateOutcome,
      staleCheckpoint: staleOutcome,
      duplicateLaunchDetails: duplicateDetails,
      staleCheckpointDetails: staleDetails,
    },
    compactions,
    eventChain: {
      path: eventChainFileRef.relative,
      sha256: eventChainFileSha256,
      eventCount: eventChain.events.length,
      finalHash: eventChain.finalHash,
    },
    rawPiSessions: sessionSummaries,
    ackFile: {
      path: ackFileRef.relative,
      sha256: ackFileSha256,
      ackCount: ackEntries.count,
    },
  };

  const summaryHash = sha256ForString(stableStringify(summary));

  return {
    benchmarkKind,
    runId,
    summary,
    summaryHash,
  };
}

export function resultDocumentFromAnalysis(analysis, schemaVersion, rawRunDir) {
  return {
    schemaVersion,
    benchmarkKind: analysis.benchmarkKind,
    runId: analysis.runId,
    rawRunDir,
    summaryHash: analysis.summaryHash,
    summary: analysis.summary,
  };
}

export function evidenceRunFromAnalysis(analysis, resultFile, rawRunDir) {
  return {
    runId: analysis.runId,
    resultFile,
    rawRunDir,
    summaryHash: analysis.summaryHash,
    handoffCount: analysis.summary.handoffCount,
    eventFinalHash: analysis.summary.eventChain.finalHash,
    duplicateOutcome: analysis.summary.outcomes.duplicateLaunch,
    staleOutcome: analysis.summary.outcomes.staleCheckpoint,
  };
}

export function evidenceDocumentFromRuns(schemaVersion, benchmarkKind, runs) {
  return {
    schemaVersion,
    benchmarkKind,
    runs,
  };
}
