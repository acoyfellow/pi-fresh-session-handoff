import { spawn } from "node:child_process";

import type { CommandKind, CommandRunMetadata } from "./types.js";

export interface CommandExecution {
  metadata: CommandRunMetadata;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  kind: CommandKind,
): Promise<CommandExecution> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const finished = Date.now();
      const metadata: CommandRunMetadata = {
        command: [command, ...args].join(" "),
        kind,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        exitCode: typeof code === "number" ? code : null,
      };

      resolve({
        metadata,
        stdout,
        stderr,
      });
    });
  });
}
