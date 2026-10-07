# Threshold hooks

Threshold hooks run custom code when a session's context usage crosses a threshold stage for the first time: `warning`, `prepare`, or `force`. A hook runs once per upward transition, in the background, so it never blocks the turn.

## Configure

List hooks under `hooks` in either config file. Global hooks run first, then project hooks.

- Global: `~/.pi/agent/fresh-session-handoff/config.json`
- Project: `<repo>/.pi/fresh-session-handoff/config.json`

```json
{
  "hooks": [
    "deja-auto-memory",
    { "module": "./hooks/my-hook.mjs", "timeoutMs": 60000, "options": { "anything": true } }
  ]
}
```

A string names a built-in hook or a module path. Relative module paths resolve from the directory of the config file that lists them; `~/` expands to the home directory. `timeoutMs` defaults to 120000.

## Write a hook

A hook module default-exports a hook object or a factory that receives `options`:

```js
export default (options) => ({
  name: "my-hook",
  stages: ["prepare", "force"],
  async run(event, tools) {
    const summary = await tools.completeWithCurrentModel(
      `Summarize:\n${event.conversation.map((turn) => `${turn.role}: ${turn.text}`).join("\n")}`,
    );
    tools.notify(`summary length ${summary.length}`);
  },
});
```

`event` fields:

| Field | Meaning |
|---|---|
| `stage` | Stage just reached: `warning`, `prepare`, or `force` |
| `previousStage` | Stage before this transition, if known |
| `sessionId`, `cwd` | Current Pi session and working directory |
| `usage` | `{ tokens, percent }` context usage |
| `conversation` | User and assistant text turns from the session |

`tools` fields:

| Field | Meaning |
|---|---|
| `completeWithCurrentModel(prompt)` | One-shot completion with the session's current model; returns text |
| `notify(message, level)` | Show a Pi notification |
| `signal` | `AbortSignal` that fires when the hook times out |

Omit `stages` to run on every stage. Failures, load errors, and timeouts are isolated: they produce a warning notification and never affect the session or other hooks. Only one hook batch runs per session at a time. On `session_shutdown` the extension waits up to 150 seconds for a running batch, so print mode (`pi -p`) does not exit mid-hook.

## Built-in: `deja-auto-memory`

Keeps Deja current as a session grows:

1. Asks the current model to extract up to `maxCandidates` durable memories (decisions, preferences, pitfalls, facts, procedures) from the most recent `maxConversationChars` of conversation.
2. Recalls each candidate from Deja in the session's repository scope.
3. Asks the current model which candidates add information not already in Deja.
4. Saves only those as Deja **drafts** with author `pi/auto-memory`. Drafts that are never kept or used expire after 24 hours.
5. When a candidate repeats a **draft that a different session wrote**, keeps that draft. A fact that comes up again in another session has proven durable, so it survives expiry instead of being saved twice. Repeats within one session are not enough. This needs a Deja CLI with `keep --from-other-session`.
6. Never records personal data about customers or other third parties. The prompt forbids it, and candidates containing emails, 32-character hex IDs, account numbers or user IDs are dropped.
7. Its own duplicate-check lookups use `recall --no-trace`, so they are not counted as agent recalls.

Options:

| Option | Default |
|---|---|
| `stages` | `["warning", "prepare", "force"]` |
| `maxCandidates` | `3` |
| `maxConversationChars` | `60000` |
| `author` | `pi/auto-memory` |
| `dejaCommand` | `["deja"]`; set e.g. `["bun", "/path/to/deja/src/cli.ts"]` for a source checkout |

Deja itself is unchanged: outside threshold transitions it is still only used on request.

## Deja session primer

Agents rarely decide to search memory on their own. The primer does it for them: on the first prompt of each session it runs `deja recall` with that prompt and, if anything matches, adds the hits to the model's context as a hidden message. Each hit shows where it was made. Nothing is added when there are no hits, and a slow or missing Deja never blocks the turn (4 second limit).

Enable it in `~/.pi/agent/fresh-session-handoff/config.json`:

```json
{ "hooks": [{ "module": "deja-session-primer", "options": { "dejaCommand": ["deja"] } }] }
```

| Option | Default |
| --- | --- |
| `dejaCommand` | `["deja"]` |
| `author` | `pi/session-primer` |
| `maxTokens` | `600` |
| `maxPromptChars` | `400` |
| `timeoutMs` | `4000` |

Primer lookups are recorded as recall receipts under `pi/session-primer`, so you can measure how often memory was put in front of an agent separately from searches agents chose to make.
