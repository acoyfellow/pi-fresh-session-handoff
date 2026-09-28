import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory, sleep } from "./utils.js";

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await ensureDirectory(directoryPath);

  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(payload, "utf8");
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }

  await rename(tempPath, filePath);
  await syncDirectory(directoryPath);
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(`${process.pid}:${Date.now()}`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

async function clearStaleLock(lockPath: string, staleAfterMs: number): Promise<void> {
  try {
    const metadata = await lstat(lockPath);
    if (Date.now() - metadata.mtimeMs > staleAfterMs) {
      await unlink(lockPath);
    }
  } catch {}
}

export async function withFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  staleAfterMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const acquired = await tryAcquireLock(lockPath);
    if (acquired) {
      try {
        return await work();
      } finally {
        try {
          await unlink(lockPath);
        } catch {}
      }
    }

    await clearStaleLock(lockPath, staleAfterMs);
    await sleep(25);
  }

  throw new Error(`Timed out waiting for lock ${lockPath}`);
}
