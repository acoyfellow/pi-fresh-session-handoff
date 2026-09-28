import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { prepareCheckpoint } from "../src/core/service.js";
import { createTempDir } from "./helpers.js";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe("threshold prepare idempotency", () => {
  it("reuses checkpoint when runtime facts have not changed", async () => {
    const cwd = await createTempDir("prepare-idempotent-");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, ".pi", "fresh-session-handoff"), { recursive: true });

    const manifest = {
      manifestVersion: "1",
      taskId: "idempotent-task",
      title: "Idempotent",
      summary: "Idempotent manifest",
      requiredModel: {
        provider: "example-provider",
        id: "example-model",
        route: "example-route",
      },
      semanticFacts: {
        source: "idempotent-test",
      },
      protectedPaths: [".env", "secrets"],
      testCommand: "npm test",
      finalProofCommand: "npm run proof",
      forbiddenModels: ["forbidden-model"],
      untrustedInstructionPaths: ["UNTRUSTED_FAKE_INSTRUCTION.md"],
      expiresMinutes: 120,
    };

    await writeFile(
      path.join(cwd, ".pi", "fresh-session-handoff", "task-manifest.v1.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(path.join(cwd, "src", "index.ts"), "export const x = 1;\n");

    run("git", ["init"], cwd);
    run("git", ["config", "core.hooksPath", "/dev/null"], cwd);
    run("git", ["config", "user.email", "test@example.com"], cwd);
    run("git", ["config", "user.name", "Test Bot"], cwd);
    run("git", ["add", "."], cwd);
    run("git", ["commit", "-m", "initial"], cwd);

    const first = await prepareCheckpoint({
      cwd,
      session: {
        sessionId: "session-idempotent",
        sessionFile: "/tmp/session-idempotent.jsonl",
        leafId: "leaf-a",
        parentSession: null,
      },
      model: {
        provider: "example-provider",
        id: "example-model",
        route: "example-route",
      },
      scopedModels: [{ model: { provider: "example-provider", id: "example-model", route: "example-route" } }],
      isModelInRegistry: () => true,
      contextUsage: {
        tokens: 200000,
        percent: 80,
        contextWindow: 272000,
      },
    });

    const second = await prepareCheckpoint({
      cwd,
      session: {
        sessionId: "session-idempotent",
        sessionFile: "/tmp/session-idempotent.jsonl",
        leafId: "leaf-a",
        parentSession: null,
      },
      model: {
        provider: "example-provider",
        id: "example-model",
        route: "example-route",
      },
      scopedModels: [{ model: { provider: "example-provider", id: "example-model", route: "example-route" } }],
      isModelInRegistry: () => true,
      contextUsage: {
        tokens: 200001,
        percent: 80,
        contextWindow: 272000,
      },
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.checkpoint.checkpointId).toBe(first.checkpoint.checkpointId);

    const sequence = await second.stateStore.getSequence("session-idempotent");
    expect(sequence).toBe(1);
  });
});
