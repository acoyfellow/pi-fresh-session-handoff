import path from "node:path";

import { describe, expect, it } from "vitest";

import { FreshSessionStateStore } from "../src/core/state-store.js";
import { createTempDir } from "./helpers.js";

describe("command history safety", () => {
  it("redacts ack payload command arguments", async () => {
    const cwd = await createTempDir("command-history-");
    const store = new FreshSessionStateStore(path.join(cwd, "state.json"), path.join(cwd, "state.lock"), {
      maxCommandHistory: 32,
      maxLaunchRecords: 32,
    });

    await store.recordCommand({
      command: '/fresh-handoff-ack {"checkpointId":"cp","secret":"token"}',
      kind: "state",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      exitCode: 0,
    });

    const history = await store.getCommandHistory();
    expect(history[0]?.command).toBe("/fresh-handoff-ack [redacted]");
    expect(history[0]?.command.includes("secret")).toBe(false);
  });

  it("caps oversized command entries", async () => {
    const cwd = await createTempDir("command-history-long-");
    const store = new FreshSessionStateStore(path.join(cwd, "state.json"), path.join(cwd, "state.lock"), {
      maxCommandHistory: 32,
      maxLaunchRecords: 32,
    });

    const longCommand = `bash ${"x".repeat(1000)}`;
    await store.recordCommand({
      command: longCommand,
      kind: "other",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      exitCode: 0,
    });

    const history = await store.getCommandHistory();
    expect(history[0]?.command.length).toBeLessThanOrEqual(321);
    expect(history[0]?.command.endsWith("…")).toBe(true);
  });
});
