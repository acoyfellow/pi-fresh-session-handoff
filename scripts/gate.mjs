import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { analyzeRawBenchmarkRun, loadBenchmarkSchema, loadJsonFile, stableStringify } from "./benchmark-harness-lib.mjs";

const cwd = process.cwd();
const dryRun = process.argv.includes("--dry-run");

const requiredFiles = [
  "README.md",
  "docs/checkpoint-format.md",
  "docs/architecture-limits.md",
  "docs/benchmark-evidence.schema.json",
  "docs/benchmark-harness.md",
  ".pi/fresh-session-handoff/task-manifest.v1.json",
  "src/extension.ts",
  "scripts/benchmark-capability-probe.mjs",
  "scripts/benchmark-live-driver.mjs",
  "scripts/benchmark-live-rpc.mjs",
  "scripts/benchmark-runner.mjs",
  "scripts/benchmark-harness-lib.mjs",
  "tests/schema.test.ts",
  "tests/benchmark-harness.test.ts",
  "tests/benchmark-live-rpc.test.ts",
  "tests/threshold-notification-switch.test.ts",
];

function assertString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid schema field ${name}`);
  }
  return value.trim();
}

function assertPositiveInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid schema field ${name}`);
  }
  return value;
}

function assertInside(rootDir, candidatePath, name) {
  const absolutePath = path.resolve(rootDir, candidatePath);
  const relativePath = path.relative(rootDir, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${name} escapes allowed root`);
  }
  return absolutePath;
}

async function ensureFiles() {
  for (const relativePath of requiredFiles) {
    const absolutePath = path.join(cwd, relativePath);
    await access(absolutePath);
  }
}

async function ensureNoBenchmarkClaim() {
  const readme = await readFile(path.join(cwd, "README.md"), "utf8");
  const positiveClaim = /benchmark success achieved|benchmarks passed|benchmark succeeded/i.test(readme);
  if (positiveClaim) {
    throw new Error("README must not claim benchmark success");
  }
}

async function validateBenchmarkEvidence(schema, evidenceDir) {
  for (const benchmarkKind of schema.requiredBenchmarkKinds) {
    const evidencePath = path.join(evidenceDir, `${benchmarkKind}.json`);
    await access(evidencePath);

    const evidenceRaw = await loadJsonFile(evidencePath, `benchmark evidence ${benchmarkKind}`);
    const evidence = typeof evidenceRaw === "object" && evidenceRaw !== null ? evidenceRaw : null;
    if (!evidence) {
      throw new Error(`invalid benchmark evidence ${benchmarkKind}`);
    }

    if (evidence.schemaVersion !== schema.schemaVersion) {
      throw new Error(`evidence schema mismatch for ${benchmarkKind}`);
    }
    if (evidence.benchmarkKind !== benchmarkKind) {
      throw new Error(`evidence benchmarkKind mismatch for ${benchmarkKind}`);
    }

    if (!Array.isArray(evidence.runs) || evidence.runs.length < schema.requiredRunCountPerKind) {
      throw new Error(`evidence run count too low for ${benchmarkKind}`);
    }

    const seenRunIds = new Set();

    for (const [index, runRaw] of evidence.runs.entries()) {
      if (typeof runRaw !== "object" || runRaw === null) {
        throw new Error(`invalid run entry ${benchmarkKind}.runs[${index}]`);
      }

      const run = runRaw;
      const runId = assertString(run.runId, `${benchmarkKind}.runs[${index}].runId`);
      if (seenRunIds.has(runId)) {
        throw new Error(`duplicate runId in evidence for ${benchmarkKind}: ${runId}`);
      }
      seenRunIds.add(runId);

      const resultFileRelative = assertString(run.resultFile, `${benchmarkKind}.runs[${index}].resultFile`);
      const rawRunDirRelative = assertString(run.rawRunDir, `${benchmarkKind}.runs[${index}].rawRunDir`);
      const summaryHash = assertString(run.summaryHash, `${benchmarkKind}.runs[${index}].summaryHash`);
      const handoffCount = assertPositiveInteger(run.handoffCount, `${benchmarkKind}.runs[${index}].handoffCount`);
      const eventFinalHash = assertString(run.eventFinalHash, `${benchmarkKind}.runs[${index}].eventFinalHash`);
      const duplicateOutcome = assertString(run.duplicateOutcome, `${benchmarkKind}.runs[${index}].duplicateOutcome`);
      const staleOutcome = assertString(run.staleOutcome, `${benchmarkKind}.runs[${index}].staleOutcome`);

      if (duplicateOutcome !== "blocked") {
        throw new Error(`duplicate outcome must be blocked for ${benchmarkKind} run ${runId}`);
      }
      if (staleOutcome !== "blocked") {
        throw new Error(`stale outcome must be blocked for ${benchmarkKind} run ${runId}`);
      }

      if (handoffCount < schema.requiredHandoffsPerRun) {
        throw new Error(`handoff count too low for ${benchmarkKind} run ${runId}`);
      }

      const resultFilePath = assertInside(evidenceDir, resultFileRelative, `${benchmarkKind} resultFile`);
      const rawRunDirPath = assertInside(cwd, rawRunDirRelative, `${benchmarkKind} rawRunDir`);

      const resultRaw = await loadJsonFile(resultFilePath, `benchmark result ${benchmarkKind}/${runId}`);
      const result = typeof resultRaw === "object" && resultRaw !== null ? resultRaw : null;
      if (!result) {
        throw new Error(`invalid result file for ${benchmarkKind} run ${runId}`);
      }

      if (result.schemaVersion !== schema.resultFileSchemaVersion) {
        throw new Error(`result schema mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (result.runId !== runId) {
        throw new Error(`result runId mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (result.benchmarkKind !== benchmarkKind) {
        throw new Error(`result benchmarkKind mismatch for ${benchmarkKind} run ${runId}`);
      }

      const resultRawRunDir = assertString(result.rawRunDir, `result rawRunDir for ${benchmarkKind} run ${runId}`);
      if (resultRawRunDir !== rawRunDirRelative) {
        throw new Error(`result rawRunDir mismatch for ${benchmarkKind} run ${runId}`);
      }

      const resultSummaryHash = assertString(result.summaryHash, `result summaryHash for ${benchmarkKind} run ${runId}`);
      if (resultSummaryHash !== summaryHash) {
        throw new Error(`result summaryHash mismatch for ${benchmarkKind} run ${runId}`);
      }

      const analysis = await analyzeRawBenchmarkRun(rawRunDirPath, schema);

      if (analysis.benchmarkKind !== benchmarkKind) {
        throw new Error(`raw benchmark kind mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (analysis.runId !== runId) {
        throw new Error(`raw runId mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (analysis.summaryHash !== summaryHash) {
        throw new Error(`summary hash mismatch for ${benchmarkKind} run ${runId}`);
      }

      const analysisSummary = stableStringify(analysis.summary);
      const resultSummary = stableStringify(result.summary);
      if (analysisSummary !== resultSummary) {
        throw new Error(`summary payload mismatch for ${benchmarkKind} run ${runId}`);
      }

      if (analysis.summary.handoffCount !== handoffCount) {
        throw new Error(`handoff count mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (analysis.summary.eventChain.finalHash !== eventFinalHash) {
        throw new Error(`event final hash mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (analysis.summary.outcomes.duplicateLaunch !== duplicateOutcome) {
        throw new Error(`duplicate outcome mismatch for ${benchmarkKind} run ${runId}`);
      }
      if (analysis.summary.outcomes.staleCheckpoint !== staleOutcome) {
        throw new Error(`stale outcome mismatch for ${benchmarkKind} run ${runId}`);
      }

      if (analysis.summary.handoffCount < schema.requiredHandoffsPerRun) {
        throw new Error(`fresh handoff count below required threshold for ${benchmarkKind} run ${runId}`);
      }
    }
  }
}

async function run() {
  await ensureFiles();
  await ensureNoBenchmarkClaim();

  const schemaPath = path.resolve(cwd, process.env.FSH_BENCHMARK_SCHEMA_PATH ?? "docs/benchmark-evidence.schema.json");
  const schema = await loadBenchmarkSchema(schemaPath);

  if (dryRun) {
    console.log(`gate dry-run passed schemaVersion=${schema.schemaVersion}`);
    return;
  }

  const evidenceDir = path.resolve(cwd, process.env.FSH_BENCHMARK_RESULTS_DIR ?? ".pi/fresh-session-handoff/benchmark-results");
  await validateBenchmarkEvidence(schema, evidenceDir);

  console.log("gate passed");
}

run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
