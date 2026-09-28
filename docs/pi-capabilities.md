# Pi capabilities audit: context detection, session handoff, launcher safety, and checkpoint protocol

## Audit scope

Required docs read completely:
- `README.md`
- `docs/extensions.md`
- `docs/sdk.md`
- `docs/tui.md`
- `docs/environment-variables.md`

Relevant linked docs read:
- `docs/compaction.md`
- `docs/session-format.md`
- `docs/sessions.md`
- `docs/settings.md`
- `docs/rpc.md`

Relevant linked examples read:
- `examples/extensions/handoff.ts`
- `examples/extensions/confirm-destructive.ts`
- `examples/extensions/reload-runtime.ts`
- `examples/extensions/trigger-compact.ts`
- `examples/extensions/git-checkpoint.ts`
- `examples/sdk/11-sessions.ts`
- `examples/sdk/13-session-runtime.ts`

`~/.pi/agent/extensions` inspected read-only, with focus on:
- `cmux-session.ts`
- `terrarium-autocontinue.ts`
- `hashline-edit/index.ts`
- `hashline-edit/vendor/{snapshots.ts,recovery.ts,mismatch.ts,patcher.ts,messages.ts}`
- `git-ai.ts`

---

## 1) Exact API/event citations

### Extension runtime APIs
- Session replacement APIs are on `ExtensionCommandContext` (command handlers only):
  - `ctx.newSession(options?)`
  - `ctx.switchSession(sessionPath, options?)`
  - `ctx.fork(entryId, options?)`
  - `ctx.navigateTree(targetId, options?)`
  - `ctx.waitForIdle()`
  - Citation: `docs/extensions.md` → **ExtensionCommandContext** and related method sections.
- Context introspection:
  - `ctx.getContextUsage()`
  - Citation: `docs/extensions.md` → **ctx.getContextUsage()**.
- Session lifecycle and settlement events:
  - `session_start`, `session_shutdown`, `session_before_switch`, `session_before_fork`
  - `agent_start`, `agent_end`, `agent_settled`
  - `turn_start`, `turn_end`
  - `session_before_compact`, `session_compact`, `session_compact_failed`
  - Citation: `docs/extensions.md` → **Events**.

### SDK APIs
- Single-session API: `createAgentSession()` returns `AgentSession`.
- Multi-session replacement API: `createAgentSessionRuntime()` + `AgentSessionRuntime` methods:
  - `runtime.newSession()`
  - `runtime.switchSession()`
  - `runtime.fork()`
- Rebind requirement after replacement:
  - re-subscribe listeners and re-bind extensions to `runtime.session`.
- Citation: `docs/sdk.md` → **AgentSession**, **createAgentSessionRuntime() and AgentSessionRuntime**, `examples/sdk/13-session-runtime.ts`.

### RPC APIs/events
- Session control commands:
  - `new_session`, `switch_session`, `fork`, `clone`
  - cancelable via extension hooks (`session_before_switch`, `session_before_fork`)
- Context stats command:
  - `get_session_stats` (`contextUsage` behavior constraints documented)
- Lifecycle events:
  - `agent_end`, `agent_settled`, `compaction_start`, `compaction_end`, `queue_update`
- Citation: `docs/rpc.md`.

---

## 2) Actual limits on context detection

1. `ctx.getContextUsage()` is not a continuously exact provider token meter.
   - It uses last assistant usage when available, then estimates trailing messages.
   - Citation: `docs/extensions.md` → **ctx.getContextUsage()**.

2. RPC `contextUsage` has explicit temporary blind spots.
   - `contextUsage` is omitted when no model/context window is available.
   - `contextUsage.tokens` and `contextUsage.percent` can be `null` immediately after compaction until a new assistant response arrives.
   - Citation: `docs/rpc.md` → **get_session_stats** notes.

3. Compaction trigger is threshold-based, not semantic “this will overflow next prompt”.
   - Trigger formula: `contextTokens > contextWindow - reserveTokens`.
   - Defaults: `reserveTokens=16384`, `keepRecentTokens=20000`.
   - Citation: `docs/compaction.md`; `docs/settings.md`.

4. Compaction summaries are lossy by design.
   - Tool-result serialization for summarization truncates tool output to 2000 characters.
   - Citation: `docs/compaction.md` → **Message Serialization**.

5. There is no dedicated “near-context-limit” event in the extension event model.
   - Practical pattern is polling `ctx.getContextUsage()` (for example on `turn_end`) and acting via `ctx.compact()`.
   - Citation: `docs/extensions.md` events/methods and `examples/extensions/trigger-compact.ts`.

---

## 3) Actual limits on starting a separate session

1. Session replacement from extensions is command-context-only.
   - `newSession/switchSession/fork` are intentionally unavailable in regular `ExtensionContext` event handlers because of deadlock risk.
   - Citation: `docs/extensions.md` → **ExtensionCommandContext**.

2. Replacement is in-place runtime replacement, not parallel multi-session execution in one active `AgentSession`.
   - `AgentSession` does not own new/resume/fork replacement APIs; `AgentSessionRuntime` does.
   - Citation: `docs/sdk.md`.

3. Post-switch stale reference hazard is real.
   - After replacement, captured old `pi`/`ctx` session-bound objects are stale and can throw; only the `withSession` replacement context is valid for session-bound operations.
   - Citation: `docs/extensions.md` → **Session replacement lifecycle and footguns**.

4. Session switch/new/fork/clone may be vetoed.
   - `session_before_switch` / `session_before_fork` can return `{ cancel: true }`.
   - RPC returns `success: true` with `data.cancelled: true` on veto.
   - Citation: `docs/extensions.md`, `docs/rpc.md`, `examples/extensions/confirm-destructive.ts`.

5. Pi core philosophy does not provide built-in sub-agents.
   - Separate independent execution requires external process/runtime orchestration.
   - Citation: `README.md` (“No sub-agents”).

---

## 4) Safe launcher fallback (audited implementation pattern)

Observed in `~/.pi/agent/extensions/cmux-session.ts`:

1. Launch argv normalization:
   - `normalizedLaunchArgv()` rewrites script-style invocations to executable-style `pi ...` where possible.
   - Citations: `cmux-session.ts` (`normalizedLaunchArgv`, `looksLikePiExecutable`, `looksLikePiScript`).

2. Environment hardening + fallback injection:
   - `hookEnvironment()` keeps an allowlist (`shouldPreserveEnvKey`) and avoids secret-like vars.
   - If launch metadata is absent, it injects:
     - `CMUX_AGENT_LAUNCH_KIND`
     - `CMUX_AGENT_LAUNCH_EXECUTABLE`
     - `CMUX_AGENT_LAUNCH_ARGV_B64`
     - `CMUX_AGENT_LAUNCH_CWD`
   - Citations: `cmux-session.ts` (`secretLikeEnvKey`, `shouldPreserveEnvKey`, `hookEnvironment`).

3. Resume argv sanitization:
   - `sanitizedResumeArgv(sessionId)` force-adds `--session <sessionId>` and removes mutable selectors (`--session`, `--resume`, `--fork`, `--api-key`, `--prompt`, `--print`) while passing through only allowlisted options.
   - Citation: `cmux-session.ts` (`piOptionsWithValue`, `piSelectorsToDrop`, `sanitizedResumeArgv`).

4. Binding write + verify round trip:
   - `ensureResumeBinding()` writes resume data with `--checkpoint-id <sessionId>` and validates via `resume get` + `resumeBindingMatches()`.
   - Citation: `cmux-session.ts` (`ensureResumeBinding`, `resumeBindingMatches`).

5. Version fallback for settlement event support:
   - `supportsAgentSettled()` gates behavior for older Pi versions without `agent_settled`.
   - Citation: `cmux-session.ts` (`supportsAgentSettled`, `agent_end`/`agent_settled` handlers).

---

## 5) Checkpoint checksum/stale/duplicate/ack protocol

### 5.1 Existing primitives available now

- Checkpoint identity primitive:
  - `checkpoint_id` used in cmux resume binding verification.
  - Citation: `cmux-session.ts` (`--checkpoint-id`, `resumeBindingMatches`).

- Stale-detection primitive:
  - Hashline extension enforces file-hash anchor checks and rejects stale tags with explicit diagnostics.
  - Snapshot store limits are explicit: max 30 paths, 4 versions/path, 64 MiB aggregate text.
  - Citations: `hashline-edit/index.ts`; `hashline-edit/vendor/snapshots.ts`; `hashline-edit/vendor/mismatch.ts`; `hashline-edit/vendor/recovery.ts`.

- Duplicate suppression primitives:
  - `settleTurn()` + `state.stopped` to prevent duplicate terminal settlement.
  - Feed compaction and bounded queueing (`maxPendingFeedCommands=8`, `maxQueuedFeedCommands=32`, terminal summary cap 64).
  - Cross-feed dedupe via `seenRunIds` in Terrarium callback bridge.
  - Citations: `cmux-session.ts`; `terrarium-autocontinue.ts`.

- Ack primitives:
  - Feed-drain deadline (`feedDrainDeadlineMs=4500`) to wait for acknowledged ingress before classifying failure.
  - Cloud callback ack (`/ack`) and local mailbox transition (`pending -> inflight -> acked`).
  - Citations: `cmux-session.ts`; `terrarium-autocontinue.ts`.

### 5.2 Gap statement (hard limit)

- There is no built-in Pi core checkpoint object with mandatory checksum/stale/duplicate/ack fields.
- No first-class SDK/extension API defines a canonical checkpoint acknowledgment contract.
- Therefore checksum+ack semantics must be extension-defined (or external service-defined).

### 5.3 Protocol design (compatible with audited APIs)

Checkpoint envelope (recommended):

```json
{
  "schemaVersion": 1,
  "checkpointId": "<sessionId>:<leafId>:<seq>",
  "sessionId": "<ctx.sessionManager.getSessionId()>",
  "leafId": "<ctx.sessionManager.getLeafId()>",
  "parentSession": "<optional session header parentSession>",
  "sequence": 42,
  "checksum": "sha256:<hex>",
  "payloadVersion": "v1",
  "createdAt": "<iso8601>",
  "source": "<extension-name>"
}
```

Recommended lifecycle:
1. Emit checkpoint only on `agent_settled` (not `agent_end`) to avoid retries/queued follow-up races.
2. Compute checksum over canonical JSON payload bytes.
3. Persist envelope locally (`pi.appendEntry(customType, data)` or external durable store).
4. Deliver envelope to consumer.
5. Require ack echoing `checkpointId` + `checksum` + `ackedAt`.
6. Mark acknowledged only when both id and checksum match.
7. Requeue unacked inflight records at next `session_start`.

Stale rule:
- Reject if `sessionId` mismatches active session.
- Reject if `leafId` no longer reachable in current session tree.
- Reject if recomputed checksum differs.

Duplicate rule:
- Idempotency key: `checkpointId`.
- Secondary guard: same `sessionId` + `leafId` + `checksum`.
- Duplicate ack is success-noop.

Ack deadline rule:
- Maintain explicit ack timeout and retry schedule.
- On timeout, preserve durable inflight record and retry later.

---

## 6) Benchmark implementation status

### 6.1 What the live harness uses
- Pi is driven through `--mode rpc` with JSONL over stdin/stdout.
- Each benchmark session is pinned to the benchmark model set by `FSH_BENCHMARK_PROVIDER`, `FSH_BENCHMARK_MODEL`, and `FSH_BENCHMARK_ROUTE`.
- The live driver uses these RPC commands in practice:
  - `get_available_models`
  - `set_auto_compaction`
  - `prompt`
  - `get_state`
  - `get_session_stats`
  - `get_last_assistant_text`
  - `compact`
- The harness captures real Pi session JSONL files from a dedicated `--session-dir` and copies them into each raw benchmark bundle.

### 6.2 Implemented benchmark scenarios

1. `fresh-session-handoff`
- Start a source session in an isolated fixture copy.
- Prepare checkpoint 1.
- Launch a fresh handoff session.
- Ack the handoff in the target session before editing.
- Make a safe edit and capture the visible assistant response.
- Prepare checkpoint 2 from the source session.
- Prove stale-check rejection by retrying launch from checkpoint 1 after sequence advance.
- Launch and ack checkpoint 2.
- Make a second safe edit in the second fresh session.
- Prove duplicate-launch rejection on the current checkpoint.

2. `normal-compaction`
- Follow the same checkpoint and handoff flow.
- Reopen the source session and call RPC `compact` explicitly between phases.
- Capture manual compaction timings and the resulting compaction entry in the source raw session JSONL.

### 6.3 Captured evidence
- checkpoint files and their deterministic checksums
- ack bundle with echoed facts
- hash-chained `events.jsonl`
- raw Pi session JSONL for the source session plus each fresh handoff session
- raw session file hashes, visible response counts, and last-visible-response hashes
- exact model selection facts
- per-checkpoint `statusDigest` and `protectedPathsDigest`
- duplicate-launch blocked outcome
- stale-checkpoint blocked outcome
- manual compaction completed outcome for `normal-compaction`

### 6.4 Practical pass criteria enforced by the gate
- no benchmark kind passes without raw run bundles
- exact model route must stay the benchmark model (`FSH_BENCHMARK_PROVIDER` / `FSH_BENCHMARK_MODEL` / `FSH_BENCHMARK_ROUTE`)
- duplicate launch must be blocked
- stale checkpoint launch must be blocked
- each run must contain at least two acknowledged fresh handoffs from distinct checkpoints
- `normal-compaction` must include completed manual compaction evidence

---

## 7) Practical takeaways

- Pi provides the needed hooks for robust context-aware handoff and session replacement, but not a built-in checkpoint checksum/ack contract.
- Reliable behavior depends on extension-level protocol discipline: settle-gated emission, checksum verification, idempotent duplicate handling, and durable ack state.
- Existing local extensions (`cmux-session`, `terrarium-autocontinue`, `hashline-edit`) already demonstrate viable safety patterns for fallback, stale detection, dedupe, and ack flow.