import path from "node:path";

import type { GitSnapshot } from "./types.js";
import { isSubPath, sortUnique, stableStringCompare } from "./utils.js";

export function resolveProtectedPaths(cwd: string, protectedPaths: string[]): string[] {
  const absolutePaths = protectedPaths.map((value) => path.resolve(cwd, value));
  return sortUnique(absolutePaths);
}

export function findMatchingProtectedPath(
  cwd: string,
  candidatePath: string,
  protectedPaths: string[],
): string | null {
  const candidateAbsolute = path.resolve(cwd, candidatePath);
  for (const protectedPath of resolveProtectedPaths(cwd, protectedPaths)) {
    if (isSubPath(protectedPath, candidateAbsolute)) {
      return protectedPath;
    }
  }
  return null;
}

export function findProtectedPathMutations(
  cwd: string,
  protectedPaths: string[],
  candidatePaths: string[],
): string[] {
  const violations: string[] = [];
  for (const candidatePath of candidatePaths) {
    const matched = findMatchingProtectedPath(cwd, candidatePath, protectedPaths);
    if (!matched) {
      continue;
    }
    violations.push(path.relative(cwd, path.resolve(cwd, candidatePath)) || ".");
  }
  return sortUnique(violations);
}

function normalizeGitStatusPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseGitStatusPaths(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  const payload = line.length >= 3 ? line.slice(3).trim() : trimmed;
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

export function dirtyPathsFromGitSnapshot(snapshot: GitSnapshot): string[] {
  const paths: string[] = [];

  for (const line of snapshot.status) {
    paths.push(...parseGitStatusPaths(line));
  }

  paths.push(...snapshot.untracked.map((value) => value.trim()).filter((value) => value.length > 0));

  return sortUnique(paths.sort(stableStringCompare));
}

export function findDirtyProtectedPaths(cwd: string, protectedPaths: string[], snapshot: GitSnapshot): string[] {
  const dirtyPaths = dirtyPathsFromGitSnapshot(snapshot);
  return findProtectedPathMutations(cwd, protectedPaths, dirtyPaths);
}
