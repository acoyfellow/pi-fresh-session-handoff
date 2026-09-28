import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { collectGitSnapshot } from "../src/core/git.js";
import { createTempDir } from "./helpers.js";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

describe("git metadata collection", () => {
  it("collects branch, commit, status, and untracked paths", async () => {
    const cwd = await createTempDir("fresh-git-");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");

    run("git", ["init"], cwd);
    run("git", ["config", "core.hooksPath", "/dev/null"], cwd);
    run("git", ["config", "user.email", "test@example.com"], cwd);
    run("git", ["config", "user.name", "Test Bot"], cwd);
    run("git", ["add", "."], cwd);
    run("git", ["commit", "-m", "init"], cwd);

    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 2;\n");
    await writeFile(path.join(cwd, "untracked.txt"), "temp\n");

    const result = await collectGitSnapshot(cwd);

    expect(result.snapshot.cwd).toBe(cwd);
    expect(result.snapshot.isRepo).toBe(true);
    expect(result.snapshot.branch).toBeTruthy();
    expect(result.snapshot.commit).toBeTruthy();
    expect(result.snapshot.status.some((line) => line.includes("src/index.ts"))).toBe(true);
    expect(result.snapshot.untracked).toContain("untracked.txt");
    expect(result.commandMetadata.length).toBeGreaterThanOrEqual(4);
  });
});
