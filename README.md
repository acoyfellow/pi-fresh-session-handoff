# pi-fresh-session-handoff

A [Pi](https://github.com/earendil-works/pi) extension that watches context-window pressure and helps you move long work into a fresh session safely, without losing the facts that matter.

It does three things:

1. **Watches context usage.** On every turn it classifies usage into `warning`, `prepare`, and `force` stages and tells you when a stage is crossed.
2. **Runs threshold hooks.** When a stage is crossed, it runs your own code: summarize, export, notify, or save memories. It ships with a hook, `deja-auto-memory`, that saves new durable facts to [Deja](https://github.com/acoyfellow/deja).
3. **Hands off to a fresh session.** It writes a typed, checksummed checkpoint, launches a new session from it, and blocks editing tools there until the new session acknowledges the checkpoint.

## Install

```bash
git clone https://github.com/acoyfellow/pi-fresh-session-handoff
cd pi-fresh-session-handoff
npm install
npm run install:extension
```

The installer copies `src/` into `~/.pi/agent/extensions/fresh-session-handoff` (override with `FSH_INSTALL_DIR`). Restart Pi or run `/reload`.

## Threshold hooks

List hooks in `~/.pi/agent/fresh-session-handoff/config.json` (all projects) or `<repo>/.pi/fresh-session-handoff/config.json` (one project):

```json
{
  "hooks": [
    "deja-auto-memory",
    { "module": "./hooks/my-hook.mjs", "timeoutMs": 60000 }
  ]
}
```

A hook is a module that exports `{ name, stages?, run(event, tools) }`, or a factory that returns one. `event` carries the stage, token usage, session ID, working directory, and conversation text. `tools` provides `completeWithCurrentModel(prompt)`, `notify(message)`, and an abort `signal`. Hooks run in the background, and failures or timeouts are reported without affecting the session. See [`docs/hooks.md`](docs/hooks.md).

### Deja auto-memory

`deja-auto-memory` runs when a threshold is crossed:

1. The current model extracts durable memories (decisions, preferences, pitfalls, facts, procedures) from recent conversation.
2. Each candidate is recalled from Deja in the repository's scope.
3. The model keeps only candidates Deja does not already have.
4. New ones are saved as Deja drafts, which expire after 24 hours unless kept or used.

It requires the `deja` CLI on `PATH`, or set `options.dejaCommand`, for example `["bun", "/path/to/deja/src/cli.ts"]`.

## Default thresholds

| Stage | Percent | Tokens |
|---|---:|---:|
| `warning` | 70% | 180,000 |
| `prepare` | 82% | 210,000 |
| `force` | 92% | 240,000 |

Either condition triggers the stage. Override the defaults in `.pi/fresh-session-handoff/config.json` under `thresholds`, or with the `FSH_WARNING_PERCENT`, `FSH_PREPARE_PERCENT`, `FSH_FORCE_PERCENT`, and matching `*_TOKENS` environment variables.

## Handoff commands

- `/fresh-handoff-status` shows context usage, stage, and model status.
- `/fresh-handoff-prepare` writes a checkpoint.
- `/fresh-handoff-launch [checkpointId] [--force]` starts a fresh session from a checkpoint. A lease prevents a duplicate launch from starting twice.
- `/fresh-handoff-ack {"checkpointId":"...","checksum":"...","facts":{...}}` acknowledges the checkpoint in the new session and unlocks editing tools.

Handoff reads a per-project task manifest at `.pi/fresh-session-handoff/task-manifest.v1.json` describing the task, protected paths, and test commands. The fixture in [`fixtures/repeatable-project/task-manifest.v1.json`](fixtures/repeatable-project/task-manifest.v1.json) is a complete example.

The manifest's `requiredModel` field is optional. Set `{ "provider": "...", "id": "...", "route": "..." }` to refuse handoffs unless that exact model is active. Omit it to accept any model.

## Safety properties

- Checkpoints are built from explicit data with deterministic, locale-independent SHA-256 checksums.
- Checkpoint and state writes are atomic (fsync and rename) and contained within the project.
- Stale checkpoints are detected from session ID, git state, sequence, and expiry.
- Protected paths are enforced against mutation, and unknown mutating tools are blocked before acknowledgement.
- Raw transcripts, tool outputs, and reasoning are never stored in checkpoints.

## Development

```bash
npm run check
```

This runs the TypeScript build, the Vitest suite, and a static gate check. Live benchmarks drive a real Pi session over RPC; set `FSH_BENCHMARK_PROVIDER`, `FSH_BENCHMARK_MODEL`, and `FSH_BENCHMARK_ROUTE` to a model you have access to, then run `npm run benchmark:live`.

## Docs

- [`docs/hooks.md`](docs/hooks.md): threshold hooks and Deja auto-memory
- [`docs/checkpoint-format.md`](docs/checkpoint-format.md): checkpoint format
- [`docs/architecture-limits.md`](docs/architecture-limits.md): architecture limits
- [`docs/benchmark-harness.md`](docs/benchmark-harness.md): benchmark harness contract
- [`docs/pi-capabilities.md`](docs/pi-capabilities.md): Pi APIs used and their constraints

## License

MIT
