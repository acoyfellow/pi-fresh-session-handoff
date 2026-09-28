# Architecture limits

## Session replacement limits

- Launch uses `ctx.newSession` from command context.
- No detached subprocess launcher is used in this product.
- Old session history is preserved as parent session metadata.

## Context usage limits

- Threshold decisions use `ctx.getContextUsage()` and inherit its estimation gaps.
- Context usage can be unavailable or stale immediately after compaction.
- Threshold notifications are enabled by default and can be suppressed only for builder processes through `thresholdNotifications.suppressInNonTestBuilderProcess` and `FSH_BUILDER_PROCESS`.
- Extension behavior is enabled by default; setting `FSH_EXTENSION_DISABLED=1` disables all extension commands and hooks only when the process is marked as a builder (`FSH_BUILDER_PROCESS=1` or `PI_BUILDER_PROCESS=1`).

## Checkpoint scope limits

- Checkpoints store typed metadata only.
- Raw transcript, tool output bodies, and assistant hidden reasoning are intentionally excluded.
- Environment capture keeps key names only, then redacts secret-like keys.

## State durability limits

- State writes are local atomic file writes under `.pi/fresh-session-handoff/state.json` with temp-write, fsync, and rename.
- Store paths reject symlink pivots and must stay inside workspace realpath containment.
- Lease transitions are CAS-bound to lease IDs and status, so expired stale writers cannot mark a later launch.
- State retains bounded history by configured limits.

## Model invariant limits

- Required model validation checks active model, route, and picker/registry presence during prepare, launch, and ack.
- Ack validation binds checkpoint checksum, lease ID, child session ID, model/provider/route, and manifest critical fact digests.
- When the task manifest sets `requiredModel`, prepare, launch, and ack fail unless that exact model is active and discoverable. Without `requiredModel`, any model is accepted.

## Benchmark status

- Gate dry-run validates required contract files and benchmark schema only.
- Live benchmark capture is separate from summary generation: `npm run benchmark:probe` confirms the exact model is available, `npm run benchmark:drive` records raw bundles from real Pi RPC sessions, and `npm run benchmark:runner` rebuilds summaries.
- `npm run check` keeps the final gate closed because it ends at `npm run gate -- --dry-run`.
- Non-dry-run gate is fail-closed and revalidates raw benchmark bundles by hash chain, raw Pi JSONL hashes, checkpoint/ack/session IDs, exact model route, per-checkpoint git/protected digests, duplicate/stale blocked outcomes, manual compaction evidence for `normal-compaction`, repeated runs, and at least two fresh handoffs from distinct checkpoints per run.
