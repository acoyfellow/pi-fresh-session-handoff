import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function runGate(
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", ["scripts/gate.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      ...envOverrides,
    },
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("policy gate", () => {
  it("passes dry-run schema validation", () => {
    const result = runGate(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gate dry-run passed");
  });

  it("fails closed without benchmark evidence files", () => {
    const missingResultsDir = path.join(repoRoot, `.tmp-gate-missing-${process.pid}-${Date.now()}`);
    const result = runGate([], {
      FSH_BENCHMARK_RESULTS_DIR: missingResultsDir,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(path.basename(missingResultsDir));
  });
});
