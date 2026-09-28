import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
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

describe("runtime extension load smoke", () => {
  it(
    "loads fresh-handoff command in real pi offline runtime",
    () => {
      const install = run("node", ["scripts/install-extension.mjs"]);
      expect(install.status).toBe(0);

      const withExtension = run("pi", ["--offline", "--print", "/fresh-handoff-status"]);
      const withOutput = `${withExtension.stdout}\n${withExtension.stderr}`;
      expect(withExtension.status).toBe(0);
      expect(withOutput).toContain("manifest path=");

      const withoutExtension = run("pi", ["--offline", "--no-extensions", "--print", "/fresh-handoff-status"]);
      const withoutOutput = `${withoutExtension.stdout}\n${withoutExtension.stderr}`;
      expect(withoutOutput.includes("manifest path=")).toBe(false);
    },
    120000,
  );
});
