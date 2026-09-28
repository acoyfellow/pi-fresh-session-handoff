# Benchmark harness evidence contract

The benchmark gate accepts only evidence produced from raw benchmark bundles that satisfy the cross-validation contract below.

## Live driver

The repository now separates live capture from summary generation:

- `npm run benchmark:probe` confirms Pi can start with the benchmark model (`FSH_BENCHMARK_PROVIDER` / `FSH_BENCHMARK_MODEL`) and that the model is listed in `get_available_models`.
- `npm run benchmark:drive` creates isolated fixture copies and records raw benchmark bundles by driving Pi over RPC.
- `npm run benchmark:runner` rebuilds result summaries and top-level evidence files from whatever raw bundles already exist.
- `npm run benchmark:live` runs the probe, the live driver, and the runner in sequence.

`npm run check` still stops at `npm run gate -- --dry-run`. The non-dry gate stays closed until real benchmark runs have executed.

## Raw run bundle layout

Each raw run directory under `benchmark-results/raw/<run-directory>/` must contain:

- `run-bundle.json`
- `acks.json`
- `events.jsonl`
- checkpoint JSON files referenced by `run-bundle.json`
- raw Pi session JSONL files referenced by `run-bundle.json`

Live runs also retain additional evidence inside the run directory:

- `workspace/` isolated fixture copy that Pi edited
- `runtime-sessions/` original Pi session files from `--session-dir`
- `state.json` copied fresh-session-handoff state store snapshot
- `driver-metadata.json` with visible responses, timings, and blocked-outcome messages

`run-bundle.json` supports the legacy single-checkpoint shape and the live multi-checkpoint shape. Live runs use the multi-checkpoint form:

```json
{
  "schemaVersion": "2",
  "benchmarkKind": "normal-compaction",
  "runId": "normal-compaction-20260830T180000000Z-run-1",
  "checkpointFiles": [
    { "handoffIndex": 1, "path": "checkpoints/checkpoint-1.json" },
    { "handoffIndex": 2, "path": "checkpoints/checkpoint-2.json" }
  ],
  "ackFile": "acks.json",
  "eventChainFile": "events.jsonl",
  "rawPiSessionFiles": [
    { "role": "source", "path": "sessions/source-session.jsonl", "sessionId": "source-session" },
    {
      "role": "handoff",
      "path": "sessions/handoff-1-session.jsonl",
      "sessionId": "handoff-1",
      "handoffIndex": 1,
      "checkpointId": "source-session:leaf-1:1"
    },
    {
      "role": "handoff",
      "path": "sessions/handoff-2-session.jsonl",
      "sessionId": "handoff-2",
      "handoffIndex": 2,
      "checkpointId": "source-session:leaf-2:2"
    }
  ],
  "stateFile": "state.json",
  "driverMetadataFile": "driver-metadata.json",
  "workspaceDir": "workspace"
}
```

The source and handoff session files are real Pi session JSONL captured from RPC-driven runs, not fabricated summaries.

## Event chain requirements

`events.jsonl` must be hash-chained with:

- `prevHash` for each event (`sha256:genesis` for event 1)
- `hash` matching `sha256(stableStringify({ index, eventType, payload, prevHash }))`

Required event types:

- one `checkpoint_prepared` event per checkpoint file used by the run
- one `raw_pi_session_hash` event per raw Pi session JSONL file
- one `fresh_handoff_acked` event per fresh handoff session
- one `duplicate_launch_outcome` event with `status="blocked"`
- one `stale_checkpoint_outcome` event with `status="blocked"`
- for `normal-compaction`, at least one `manual_compaction_outcome` event with `status="completed"` and `reason="manual"`

Live runs also populate timing fields on `checkpoint_prepared`, `fresh_handoff_acked`, `duplicate_launch_outcome`, `stale_checkpoint_outcome`, and `manual_compaction_outcome` payloads.

## Cross-validation checks

Runner and gate both recompute validation from raw files and must agree on all of:

- event chain integrity and final chain hash
- raw Pi JSONL file hashes, event counts, visible response counts, and visible-response hashes when present
- checkpoint/checksum/session IDs across checkpoint files, ack payloads, and events
- exact model invariant the benchmark model (`FSH_BENCHMARK_PROVIDER` / `FSH_BENCHMARK_MODEL` / `FSH_BENCHMARK_ROUTE`)
- `statusDigest` and `protectedPathsDigest` parity across checkpoint facts, ack facts, and events
- duplicate/stale blocked outcomes
- at least two fresh handoffs per run
- distinct checkpoints for each required handoff session
- explicit manual compaction evidence for `normal-compaction`
- repeated runs per benchmark kind from `docs/benchmark-evidence.schema.json`

## Commands

Record fresh raw benchmark bundles with live Pi sessions:

```bash
npm run benchmark:drive
```

Rebuild result summaries and top-level evidence from existing raw bundles:

```bash
npm run benchmark:runner
```

Run the short real model-availability probe only:

```bash
npm run benchmark:probe
```

Run the full local benchmark pipeline:

```bash
npm run benchmark:live
```

Validate policy gate without requiring benchmark files:

```bash
npm run gate -- --dry-run
```

Validate fail-closed gate with benchmark evidence:

```bash
npm run gate
```

The non-dry gate fails when required benchmark evidence is absent or when result or evidence files do not match recomputed raw bundle facts.

## Test fixtures

`tests/benchmark-harness.test.ts` generates synthetic but structurally real raw bundles in a temp directory, runs `scripts/benchmark-runner.mjs`, and validates that `scripts/gate.mjs`:

- passes with consistent runner output
- rejects tampered summaries
- rejects schema-only fabricated files

`tests/benchmark-live-rpc.test.ts` covers mocked RPC process control for LF-framed JSONL parsing, request/response correlation, idle waiting, and automatic cancellation of unexpected extension dialogs.
