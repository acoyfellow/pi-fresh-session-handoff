import path from "node:path";

import { describe, expect, it } from "vitest";

import { FreshSessionStateStore } from "../src/core/state-store.js";
import { sampleCheckpoint, createTempDir } from "./helpers.js";

describe("state flow integration", () => {
  it("tracks launch and ack state per target session", async () => {
    const dir = await createTempDir("fresh-state-");
    const store = new FreshSessionStateStore(path.join(dir, "state.json"), path.join(dir, "state.lock"), {
      maxCommandHistory: 64,
      maxLaunchRecords: 64,
    });

    const checkpoint = sampleCheckpoint();
    await store.registerPreparedCheckpoint(checkpoint);

    const lease = await store.acquireLaunchLease({
      checkpointId: checkpoint.checkpointId,
      checksum: checkpoint.checksum,
      sourceSessionId: checkpoint.session.sessionId,
      sourceSessionFile: checkpoint.session.sessionFile,
      expiresAt: checkpoint.expiresAt,
      leaseTtlSeconds: 60,
    });

    expect(lease.acquired).toBe(true);

    const launched = await store.markLaunchLaunched(checkpoint.checkpointId, lease.record.leaseId, "target-session");
    expect(launched.updated).toBe(true);

    const pending = await store.getPendingLaunchForTargetSession("target-session");
    expect(pending?.checkpointId).toBe(checkpoint.checkpointId);

    const acked = await store.markLaunchAcked(
      checkpoint.checkpointId,
      lease.record.leaseId,
      "target-session",
      checkpoint.checksum,
    );
    expect(acked.updated).toBe(true);

    const afterAck = await store.getPendingLaunchForTargetSession("target-session");
    expect(afterAck).toBeNull();

    const sessionAcked = await store.isSessionAcked("target-session");
    expect(sessionAcked).toBe(true);
  });
});
