import { checksumForValue } from "./checksum.js";
import { ROOT_RELATIVE_PATH } from "./constants.js";
import { runCommand } from "./command.js";
import type { CommandRunMetadata, GitSnapshot } from "./types.js";

export interface GitCollectionResult {
  snapshot: GitSnapshot;
  commandMetadata: CommandRunMetadata[];
}

function normalizeGitStatusPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractStatusPaths(line: string): string[] {
  const payload = line.length >= 3 ? line.slice(3).trim() : line.trim();
  if (!payload) {
    return [];
  }

  if (payload.includes(" -> ")) {
    return payload
      .split(" -> ")
      .map(normalizeGitStatusPath)
      .filter((entry) => entry.length > 0);
  }

  return [normalizeGitStatusPath(payload)];
}

function isInternalStorePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized === ROOT_RELATIVE_PATH || normalized.startsWith(`${ROOT_RELATIVE_PATH}/`);
}

function parseStatusLines(lines: string[]): { status: string[]; untracked: string[] } {
  const status: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const trackedPaths = extractStatusPaths(line);
    if (trackedPaths.length > 0 && trackedPaths.every((entry) => isInternalStorePath(entry))) {
      continue;
    }

    status.push(line);
    if (line.startsWith("?? ")) {
      const untrackedPath = line.slice(3).trim();
      if (!isInternalStorePath(untrackedPath)) {
        untracked.push(untrackedPath);
      }
    }
  }

  return { status, untracked };
}

async function gitCommand(cwd: string, args: string[]): Promise<{ metadata: CommandRunMetadata; stdout: string; ok: boolean }> {
  const result = await runCommand("git", args, cwd, "git");
  const ok = result.metadata.exitCode === 0;
  return {
    metadata: result.metadata,
    stdout: result.stdout,
    ok,
  };
}

export async function collectGitSnapshot(cwd: string): Promise<GitCollectionResult> {
  const commandMetadata: CommandRunMetadata[] = [];

  const isRepoResult = await gitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]);
  commandMetadata.push(isRepoResult.metadata);
  if (!isRepoResult.ok || isRepoResult.stdout.trim() !== "true") {
    const statusDigest = checksumForValue({ status: [], untracked: [] });
    return {
      snapshot: {
        cwd,
        isRepo: false,
        branch: null,
        commit: null,
        status: [],
        untracked: [],
        statusDigest,
        dirty: false,
      },
      commandMetadata,
    };
  }

  const branchResult = await gitCommand(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitResult = await gitCommand(cwd, ["rev-parse", "HEAD"]);
  const statusResult = await gitCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  commandMetadata.push(branchResult.metadata, commitResult.metadata, statusResult.metadata);

  const statusLines = statusResult.stdout.split(/\r?\n/);
  const parsed = parseStatusLines(statusLines);
  const statusDigest = checksumForValue({
    status: parsed.status,
    untracked: parsed.untracked,
  });

  return {
    snapshot: {
      cwd,
      isRepo: true,
      branch: branchResult.ok ? branchResult.stdout.trim() || null : null,
      commit: commitResult.ok ? commitResult.stdout.trim() || null : null,
      status: parsed.status,
      untracked: parsed.untracked,
      statusDigest,
      dirty: parsed.status.length > 0,
    },
    commandMetadata,
  };
}
