import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { prepareCheckpoint } from "../src/core/service.js";
import { verifyCheckpointChecksum } from "../src/core/checkpoint.js";
import { createTempDir } from "./helpers.js";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe("prepare checkpoint integration", () => {
  it("builds checkpoint from manifest and collected metadata", async () => {
    const cwd = await createTempDir("prepare-integration-");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, ".pi", "fresh-session-handoff"), { recursive: true });

    const manifest = {
      manifestVersion: "1",
      taskId: "integration-task",
      title: "Integration",
      summary: "Integration manifest",
      requiredModel: {
        provider: "example-provider",
        id: "example-model",
        route: "example-route",
      },
      semanticFacts: {
        source: "integration-test",
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
    await writeFile(
      path.join(cwd, ".pi", "fresh-session-handoff", "config.json"),
      `${JSON.stringify(
        {
          manifestPath: ".pi/fresh-session-handoff/task-manifest.v1.json",
          checkpointTtlMinutes: 120,
          leaseTtlSeconds: 60,
          stateLimits: { maxCommandHistory: 64, maxLaunchRecords: 64 },
          thresholds: {
            warningPercent: 70,
            preparePercent: 82,
            forcePercent: 92,
            warningTokens: 180000,
            prepareTokens: 210000,
            forceTokens: 240000,
          },
        },
        null,
        2,
      )}\n`,
    );

    await writeFile(path.join(cwd, "src", "index.ts"), "export const x = 1;\n");

    run("git", ["init"], cwd);
    run("git", ["config", "core.hooksPath", "/dev/null"], cwd);
    run("git", ["config", "user.email", "test@example.com"], cwd);
    run("git", ["config", "user.name", "Test Bot"], cwd);
    run("git", ["add", "."], cwd);
    run("git", ["commit", "-m", "initial"], cwd);

    await writeFile(path.join(cwd, "src", "index.ts"), "export const x = 2;\n");
    await writeFile(path.join(cwd, "scratch.txt"), "untracked\n");

    process.env.TEST_SECRET_API_KEY = "secret";

    const result = await prepareCheckpoint({
      cwd,
      session: {
        sessionId: "session-integration",
        sessionFile: "/tmp/session.jsonl",
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

    expect(verifyCheckpointChecksum(result.checkpoint)).toBe(true);
    expect(result.checkpoint.taskManifest.taskId).toBe("integration-task");
    expect(result.checkpoint.git.status.some((line) => line.includes("src/index.ts"))).toBe(true);
    expect(result.checkpoint.git.untracked).toContain("scratch.txt");
    expect(result.checkpoint.redaction.removedEnvKeys).toContain("TEST_SECRET_API_KEY");
    expect(result.checkpoint.semanticTaskFacts.source).toBe("integration-test");
    expect(result.checkpoint.untrustedInstructionData[0]?.path).toBe("UNTRUSTED_FAKE_INSTRUCTION.md");
    expect(result.checkpoint.commandMetadata.length).toBeGreaterThan(0);
  });
});
