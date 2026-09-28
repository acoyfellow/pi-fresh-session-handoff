import path from "node:path";

import { describe, expect, it } from "vitest";

import { FreshSessionStateStore } from "../src/core/state-store.js";
import { createTempDir } from "./helpers.js";

describe("launch dedupe and lease guard", () => {
  it("prevents duplicate launch while lease is active", async () => {
    const dir = await createTempDir();
    const stateStore = new FreshSessionStateStore(
      path.join(dir, "state.json"),
      path.join(dir, "state.lock"),
      { maxCommandHistory: 32, maxLaunchRecords: 32 },
    );

    const first = await stateStore.acquireLaunchLease({
      checkpointId: "cp-1",
      checksum: "sha256:abc",
      sourceSessionId: "source-1",
      sourceSessionFile: "/tmp/source.jsonl",
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 60,
    });

    const second = await stateStore.acquireLaunchLease({
      checkpointId: "cp-1",
      checksum: "sha256:abc",
      sourceSessionId: "source-1",
      sourceSessionFile: "/tmp/source.jsonl",
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 60,
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe("lease-active");
  });

  it("dedupes after launched state", async () => {
    const dir = await createTempDir();
    const stateStore = new FreshSessionStateStore(
      path.join(dir, "state.json"),
      path.join(dir, "state.lock"),
      { maxCommandHistory: 32, maxLaunchRecords: 32 },
    );

    const first = await stateStore.acquireLaunchLease({
      checkpointId: "cp-2",
      checksum: "sha256:def",
      sourceSessionId: "source-2",
      sourceSessionFile: "/tmp/source2.jsonl",
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 60,
    });
    expect(first.acquired).toBe(true);

    const launched = await stateStore.markLaunchLaunched("cp-2", first.record.leaseId, "target-2");
    expect(launched.updated).toBe(true);

    const second = await stateStore.acquireLaunchLease({
      checkpointId: "cp-2",
      checksum: "sha256:def",
      sourceSessionId: "source-2",
      sourceSessionFile: "/tmp/source2.jsonl",
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 60,
    });

    expect(second.acquired).toBe(false);
    expect(second.reason).toBe("already-launched");
  });

  it("rejects stale expired lease writers after reacquire", async () => {
    const dir = await createTempDir();
    const stateStore = new FreshSessionStateStore(
      path.join(dir, "state.json"),
      path.join(dir, "state.lock"),
      { maxCommandHistory: 32, maxLaunchRecords: 32 },
    );

    const first = await stateStore.acquireLaunchLease({
      checkpointId: "cp-3",
      checksum: "sha256:ghi",
      sourceSessionId: "source-3",
      sourceSessionFile: "/tmp/source3.jsonl",
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 1,
    });
    expect(first.acquired).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1300));

    const second = await stateStore.acquireLaunchLease({
      checkpointId: "cp-3",
      checksum: "sha256:ghi",
      sourceSessionId: "source-3",
      sourceSessionFile: "/tmp/source3.jsonl",
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 60,
    });

    expect(second.acquired).toBe(true);
    expect(second.record.leaseId).not.toBe(first.record.leaseId);

    const staleLaunch = await stateStore.markLaunchLaunched("cp-3", first.record.leaseId, "stale-target");
    expect(staleLaunch.updated).toBe(false);
    expect(staleLaunch.reason).toBe("lease-mismatch");

    const validLaunch = await stateStore.markLaunchLaunched("cp-3", second.record.leaseId, "target-3");
    expect(validLaunch.updated).toBe(true);
    expect(validLaunch.record?.targetSessionId).toBe("target-3");
  });
});
