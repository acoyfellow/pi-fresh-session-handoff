import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import { assertSafePath } from "./paths.js";
import type { FreshSessionCheckpointV1 } from "./types.js";

function checkpointFileName(checkpointId: string): string {
  return `${encodeURIComponent(checkpointId)}.json`;
}

export class CheckpointStore {
  private readonly rootDir: string;
  private readonly checkpointsDir: string;

  constructor(rootDir: string, checkpointsDir: string) {
    this.rootDir = rootDir;
    this.checkpointsDir = checkpointsDir;
  }

  filePathFor(checkpointId: string): string {
    return path.join(this.checkpointsDir, checkpointFileName(checkpointId));
  }

  private async assertCheckpointStoreSafe(): Promise<void> {
    await assertSafePath(this.rootDir, this.checkpointsDir, "checkpoints directory");
  }

  async save(checkpoint: FreshSessionCheckpointV1): Promise<string> {
    await this.assertCheckpointStoreSafe();
    const filePath = this.filePathFor(checkpoint.checkpointId);
    await assertSafePath(this.rootDir, filePath, "checkpoint file");
    await writeJsonAtomic(filePath, checkpoint);
    return filePath;
  }

  async load(checkpointId: string): Promise<FreshSessionCheckpointV1 | null> {
    await this.assertCheckpointStoreSafe();
    const filePath = this.filePathFor(checkpointId);
    await assertSafePath(this.rootDir, filePath, "checkpoint file");

    try {
      const metadata = await lstat(filePath);
      if (!metadata.isFile()) {
        return null;
      }
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as FreshSessionCheckpointV1;
    } catch {
      return null;
    }
  }

  async list(): Promise<FreshSessionCheckpointV1[]> {
    await this.assertCheckpointStoreSafe();
    try {
      const files = await readdir(this.checkpointsDir);
      const output: FreshSessionCheckpointV1[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }

        const fullPath = path.join(this.checkpointsDir, file);
        await assertSafePath(this.rootDir, fullPath, "checkpoint file");
        const metadata = await lstat(fullPath);
        if (!metadata.isFile()) {
          continue;
        }

        try {
          const content = await readFile(fullPath, "utf8");
          output.push(JSON.parse(content) as FreshSessionCheckpointV1);
        } catch {}
      }
      return output;
    } catch {
      return [];
    }
  }

  async latestForSession(sessionId: string): Promise<FreshSessionCheckpointV1 | null> {
    const checkpoints = await this.list();
    const match = checkpoints
      .filter((checkpoint) => checkpoint.session.sessionId === sessionId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return match ?? null;
  }
}
