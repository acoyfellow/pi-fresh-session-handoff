import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { CHECKPOINTS_DIR_NAME, ROOT_RELATIVE_PATH, STATE_FILE_NAME } from "./constants.js";
import { isSubPath } from "./utils.js";

export interface StorePaths {
  workspaceDir: string;
  rootDir: string;
  checkpointsDir: string;
  stateFile: string;
  lockFile: string;
}

type FileStats = Awaited<ReturnType<typeof lstat>>;

async function statIfExists(pathValue: string): Promise<FileStats | null> {
  try {
    return await lstat(pathValue);
  } catch {
    return null;
  }
}

async function baseCandidates(basePath: string): Promise<string[]> {
  const resolvedBase = path.resolve(basePath);
  try {
    const realBase = await realpath(resolvedBase);
    if (realBase === resolvedBase) {
      return [resolvedBase];
    }
    return [resolvedBase, realBase];
  } catch {
    return [resolvedBase];
  }
}

function assertContainedPath(basePaths: string[], candidatePath: string, label: string): string {
  for (const basePath of basePaths) {
    if (isSubPath(basePath, candidatePath)) {
      return basePath;
    }
  }
  throw new Error(`${label} escapes workspace containment: ${candidatePath}`);
}

async function assertNoSymlink(pathValue: string, label: string): Promise<void> {
  const stats = await statIfExists(pathValue);
  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symlink: ${pathValue}`);
  }
}

async function assertNoSymlinkAncestors(basePaths: string[], targetPath: string, label: string): Promise<void> {
  const matchedBase = assertContainedPath(basePaths, targetPath, label);
  const relative = path.relative(matchedBase, targetPath);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = matchedBase;

  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = await statIfExists(current);
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} contains symlink segment: ${current}`);
    }
  }
}

async function assertRealpathContained(basePaths: string[], targetPath: string, label: string): Promise<void> {
  const stats = await statIfExists(targetPath);
  if (!stats) {
    return;
  }
  const targetReal = await realpath(targetPath);
  assertContainedPath(basePaths, targetReal, label);
}

export async function assertSafePath(basePath: string, targetPath: string, label: string): Promise<void> {
  const bases = await baseCandidates(basePath);
  const resolvedTarget = path.resolve(targetPath);
  await assertNoSymlink(resolvedTarget, label);
  await assertNoSymlinkAncestors(bases, resolvedTarget, label);
  await assertRealpathContained(bases, resolvedTarget, label);
}

async function ensureSafeDirectory(basePath: string, directoryPath: string, label: string): Promise<string> {
  await assertSafePath(basePath, directoryPath, label);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await assertSafePath(basePath, directoryPath, label);
  const directoryReal = await realpath(directoryPath);
  const bases = await baseCandidates(basePath);
  assertContainedPath(bases, directoryReal, label);
  return directoryReal;
}

export async function resolveStorePaths(cwd: string): Promise<StorePaths> {
  const workspaceDir = await realpath(cwd);
  const rootDirCandidate = path.resolve(workspaceDir, ROOT_RELATIVE_PATH);
  const rootDir = await ensureSafeDirectory(workspaceDir, rootDirCandidate, "fresh-session-handoff store root");

  const checkpointsDirCandidate = path.join(rootDir, CHECKPOINTS_DIR_NAME);
  const checkpointsDir = await ensureSafeDirectory(rootDir, checkpointsDirCandidate, "checkpoints directory");

  const stateFile = path.join(rootDir, STATE_FILE_NAME);
  const lockFile = path.join(rootDir, `${STATE_FILE_NAME}.lock`);
  await assertSafePath(rootDir, stateFile, "state file");
  await assertSafePath(rootDir, lockFile, "state lock file");

  return {
    workspaceDir,
    rootDir,
    checkpointsDir,
    stateFile,
    lockFile,
  };
}
