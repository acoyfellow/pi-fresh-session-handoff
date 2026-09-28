import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveStorePaths } from "../src/core/paths.js";
import { FreshSessionStateStore } from "../src/core/state-store.js";
import { createTempDir } from "./helpers.js";

describe("store path safety", () => {
  it("rejects symlinked store root escape", async () => {
    const cwd = await createTempDir("path-safety-root-");
    const outside = await createTempDir("path-safety-outside-");

    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await symlink(outside, path.join(cwd, ".pi", "fresh-session-handoff"));

    await expect(resolveStorePaths(cwd)).rejects.toThrow(/symlink/i);
  });

  it("rejects symlinked state file escape", async () => {
    const cwd = await createTempDir("path-safety-state-");
    const outside = await createTempDir("path-safety-outside-state-");
    const paths = await resolveStorePaths(cwd);

    const outsideState = path.join(outside, "state.json");
    await writeFile(outsideState, "{}\n");
    await symlink(outsideState, paths.stateFile);

    const stateStore = new FreshSessionStateStore(paths.stateFile, paths.lockFile, {
      maxCommandHistory: 16,
      maxLaunchRecords: 16,
    });

    await expect(stateStore.readState()).rejects.toThrow(/symlink/i);
  });
});
