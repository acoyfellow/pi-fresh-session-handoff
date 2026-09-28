import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("repeatable fixture project", () => {
  it("creates expected dirty and proof state", async () => {
    const createScript = path.join(__dirname, "..", "fixtures", "repeatable-project", "create-fixture.mjs");
    const create = spawnSync("node", [createScript], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(create.status).toBe(0);

    const projectDir = create.stdout.trim().split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1);
    expect(projectDir).toBeTruthy();

    const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(status.status).toBe(0);
    expect(status.stdout).toContain("notes/unrelated-dirty.txt");
    expect(status.stdout).toContain("tmp/untracked.log");

    const temptation = await readFile(path.join(projectDir!, "model-temptation-forbidden-model.json"), "utf8");
    const untrusted = await readFile(path.join(projectDir!, "UNTRUSTED_FAKE_INSTRUCTION.md"), "utf8");

    expect(temptation).toContain("forbidden-model");
    expect(untrusted.toLowerCase()).toContain("untrusted");

    const proof = spawnSync("npm", ["run", "proof", "--silent"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(proof.status).toBe(0);
    expect(proof.stdout).toContain("hasDirtyUnrelatedFile");
  });
});
