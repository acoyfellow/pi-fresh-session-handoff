import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeRawBenchmarkRun,
  evidenceDocumentFromRuns,
  evidenceRunFromAnalysis,
  loadBenchmarkSchema,
  resultDocumentFromAnalysis,
} from "./benchmark-harness-lib.mjs";

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function parseArgs(argv) {
  const parsed = {
    rawRoot: undefined,
    resultsRoot: undefined,
    schemaPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--raw-root") {
      parsed.rawRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--results-root") {
      parsed.resultsRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--schema") {
      parsed.schemaPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${token}`);
  }

  return parsed;
}

async function hasRunBundle(rawRunDir) {
  const bundlePath = path.join(rawRunDir, "run-bundle.json");
  try {
    await access(bundlePath);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  const rawRoot = path.resolve(cwd, args.rawRoot ?? process.env.FSH_BENCHMARK_RAW_ROOT ?? "benchmark-results/raw");
  const resultsRoot = path.resolve(
    cwd,
    args.resultsRoot ?? process.env.FSH_BENCHMARK_RESULTS_DIR ?? ".pi/fresh-session-handoff/benchmark-results",
  );
  const schemaPath = path.resolve(cwd, args.schemaPath ?? process.env.FSH_BENCHMARK_SCHEMA_PATH ?? "docs/benchmark-evidence.schema.json");

  const schema = await loadBenchmarkSchema(schemaPath);

  const entries = await readdir(rawRoot, { withFileTypes: true });
  const analyses = [];
  const skippedRawRunDirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const rawRunDir = path.join(rawRoot, entry.name);
    const completeRun = await hasRunBundle(rawRunDir);
    if (!completeRun) {
      skippedRawRunDirs.push(entry.name);
      continue;
    }

    const analysis = await analyzeRawBenchmarkRun(rawRunDir, schema);
    analyses.push({
      rawRunDir,
      analysis,
    });
  }

  if (analyses.length === 0) {
    throw new Error(`no complete raw benchmark runs found in ${rawRoot}`);
  }

  const runIdTracker = new Set();
  for (const { analysis } of analyses) {
    const key = `${analysis.benchmarkKind}:${analysis.runId}`;
    if (runIdTracker.has(key)) {
      throw new Error(`duplicate benchmark runId ${key}`);
    }
    runIdTracker.add(key);
  }

  const evidenceByKind = new Map();

  for (const { rawRunDir, analysis } of analyses) {
    const runFileName = `${analysis.runId}.json`;
    const resultFileRelative = toPosixPath(path.join("runs", analysis.benchmarkKind, runFileName));
    const resultFileAbsolute = path.join(resultsRoot, resultFileRelative);
    const rawRunDirRelative = toPosixPath(path.relative(cwd, rawRunDir));

    const resultDocument = resultDocumentFromAnalysis(analysis, schema.resultFileSchemaVersion, rawRunDirRelative);

    await mkdir(path.dirname(resultFileAbsolute), { recursive: true });
    await writeFile(resultFileAbsolute, `${JSON.stringify(resultDocument, null, 2)}\n`, "utf8");

    const evidenceRun = evidenceRunFromAnalysis(analysis, resultFileRelative, rawRunDirRelative);
    if (!evidenceByKind.has(analysis.benchmarkKind)) {
      evidenceByKind.set(analysis.benchmarkKind, []);
    }
    evidenceByKind.get(analysis.benchmarkKind).push(evidenceRun);
  }

  for (const [benchmarkKind, runs] of evidenceByKind.entries()) {
    runs.sort((a, b) => a.runId.localeCompare(b.runId));
    const evidenceDocument = evidenceDocumentFromRuns(schema.schemaVersion, benchmarkKind, runs);
    const evidencePath = path.join(resultsRoot, `${benchmarkKind}.json`);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidenceDocument, null, 2)}\n`, "utf8");
  }

  const kinds = [...evidenceByKind.keys()].sort();
  console.log(`benchmark runner wrote ${analyses.length} run results to ${resultsRoot}`);
  console.log(`benchmark kinds: ${kinds.join(",")}`);
  if (skippedRawRunDirs.length > 0) {
    console.log(`skipped incomplete raw runs: ${skippedRawRunDirs.join(",")}`);
  }
}

run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
