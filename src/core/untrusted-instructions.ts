import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "./checksum.js";
import type { UntrustedInstructionSnapshot } from "./types.js";
import { isSubPath, sortUnique, stableStringCompare } from "./utils.js";

type FileStats = Awaited<ReturnType<typeof lstat>>;

async function lstatIfExists(pathValue: string): Promise<FileStats | null> {
  try {
    return await lstat(pathValue);
  } catch {
    return null;
  }
}

export async function collectUntrustedInstructionData(
  cwd: string,
  untrustedInstructionPaths: string[],
): Promise<UntrustedInstructionSnapshot[]> {
  const workspaceResolved = path.resolve(cwd);
  const workspaceDir = await realpath(cwd);
  const normalizedPaths = sortUnique(untrustedInstructionPaths);
  const snapshots: UntrustedInstructionSnapshot[] = [];

  for (const relativePath of normalizedPaths) {
    const absolutePath = path.resolve(cwd, relativePath);
    const insideResolved = isSubPath(workspaceResolved, absolutePath);
    const insideReal = isSubPath(workspaceDir, absolutePath);
    if (!insideResolved && !insideReal) {
      throw new Error(`untrusted instruction path escapes workspace: ${relativePath}`);
    }

    const stats = await lstatIfExists(absolutePath);
    if (!stats) {
      snapshots.push({
        path: relativePath,
        exists: false,
        checksum: null,
        bytes: null,
      });
      continue;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`untrusted instruction path cannot be a symlink: ${relativePath}`);
    }

    const real = await realpath(absolutePath);
    if (!isSubPath(workspaceDir, real)) {
      throw new Error(`untrusted instruction path resolves outside workspace: ${relativePath}`);
    }

    if (!stats.isFile()) {
      throw new Error(`untrusted instruction path must be a file: ${relativePath}`);
    }

    const fileBytes = await readFile(absolutePath);
    snapshots.push({
      path: relativePath,
      exists: true,
      checksum: `sha256:${sha256Hex(fileBytes)}`,
      bytes: fileBytes.byteLength,
    });
  }

  return snapshots.sort((a, b) => stableStringCompare(a.path, b.path));
}
