import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { findProtectedPathMutations } from "../src/core/protected-paths.js";
import { prepareCheckpoint } from "../src/core/service.js";
import { createTempDir } from "./helpers.js";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe("protected path policy", () => {
  it("detects protected-path mutations for explicit mutator paths", () => {
    const violations = findProtectedPathMutations(
      "/workspace",
      [".env", "secrets", "protected/locked.txt"],
      ["src/index.ts", "protected/locked.txt", "secrets/api.key"],
    );

    expect(violations).toEqual(["protected/locked.txt", "secrets/api.key"]);
  });

  it("blocks checkpoint preparation when protected paths are dirty", async () => {
    const cwd = await createTempDir("protected-prepare-");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, "protected"), { recursive: true });
    await mkdir(path.join(cwd, ".pi", "fresh-session-handoff"), { recursive: true });

    const manifest = {
      manifestVersion: "1",
      taskId: "protected-task",
      title: "Protected",
      summary: "Protected manifest",
      requiredModel: {
        provider: "example-provider",
        id: "example-model",
        route: "example-route",
      },
      semanticFacts: {},
      protectedPaths: ["protected"],
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
    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(cwd, "protected", "locked.txt"), "locked\n");

    run("git", ["init"], cwd);
    run("git", ["config", "core.hooksPath", "/dev/null"], cwd);
    run("git", ["config", "user.email", "test@example.com"], cwd);
    run("git", ["config", "user.name", "Test Bot"], cwd);
    run("git", ["add", "."], cwd);
    run("git", ["commit", "-m", "initial"], cwd);

    await writeFile(path.join(cwd, "protected", "locked.txt"), "changed\n");

    await expect(
      prepareCheckpoint({
        cwd,
        session: {
          sessionId: "session-protected",
          sessionFile: "/tmp/session-protected.jsonl",
          leafId: "leaf-a",
          parentSession: null,
        },
        model: {
          provider: "example-provider",
          id: "example-model",
          route: "example-route",
        },
        scopedModels: [
          { model: { provider: "example-provider", id: "example-model", route: "example-route" } },
        ],
        isModelInRegistry: () => true,
        contextUsage: {
          tokens: 100000,
          percent: 60,
          contextWindow: 272000,
        },
      }),
    ).rejects.toThrow(/protected paths are dirty/i);
  });
});
