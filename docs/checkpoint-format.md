# Checkpoint format

Checkpoint files are written to `.pi/fresh-session-handoff/checkpoints/*.json`.

## Schema

`FreshSessionCheckpointV1`

- `schemaVersion`: `"1"`
- `protocol`: `"fresh-session-handoff"`
- `checkpointId`: `<sessionId>:<leafId>:<sequence>`
- `sequence`
- `createdAt`
- `expiresAt`
- `checksum`: canonical SHA-256 over the checkpoint payload without the `checksum` field
- `source`
  - `extension`
  - `extensionVersion`
  - `machine`
- `session`
  - `sessionId`
  - `sessionFile`
  - `leafId`
  - `parentSession`
- `usage`
  - `tokens`
  - `percent`
  - `contextWindow`
  - `capturedAt`
- `model`
  - `provider`
  - `id`
  - `route`
  - `displayName`
- `git`
  - `cwd`
  - `isRepo`
  - `branch`
  - `commit`
  - `status[]`
  - `untracked[]`
  - `statusDigest`
  - `dirty`
- `taskManifest`
- `semanticTaskFacts`
- `untrustedInstructionData[]`
  - `path`
  - `exists`
  - `checksum`
  - `bytes`
- `commandMetadata[]`
- `testMetadata`
  - `command`
  - `finalProofCommand`
  - `lastTestRun`
  - `lastProofRun`
- `redaction`
  - `removedEnvKeys[]`
  - `keptEnvKeys[]`
  - `transcriptStored=false`
  - `toolOutputsStored=false`
  - `assistantReasoningStored=false`
- `criticalFacts`
  - `manifestVersion`
  - `taskId`
  - `requiredModelProvider`
  - `requiredModelId`
  - `requiredModelRoute`
  - `branch`
  - `commit`
  - `statusDigest`
  - `sequence`
  - `testCommand`
  - `finalProofCommand`
  - `protectedPathsDigest`
  - `forbiddenModelsDigest`
  - `semanticFactsDigest`
  - `untrustedInstructionPathsDigest`
  - `untrustedInstructionDataDigest`

## Ack challenge

Fresh-session launch writes a launch marker and challenge prompt. The new session must run `/fresh-handoff-ack` with JSON payload:

```json
{
  "checkpointId": "...",
  "checksum": "sha256:...",
  "targetSessionId": "...",
  "leaseId": "...",
  "facts": {
    "manifestVersion": "1",
    "taskId": "...",
    "requiredModelProvider": "example-provider",
    "requiredModelId": "example-model",
    "requiredModelRoute": "example-route",
    "branch": "...",
    "commit": "...",
    "statusDigest": "sha256:...",
    "sequence": 1,
    "testCommand": "npm run check",
    "finalProofCommand": "npm run fixture:proof",
    "protectedPathsDigest": "sha256:..."
  }
}
```

Mutating tools stay blocked until checkpoint ID, checksum, target session ID, lease ID, and machine-verifiable facts all validate.
