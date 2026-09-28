import { describe, expect, it } from "vitest";

import { buildAckTemplate, buildRuntimeFacts, parseAckPayload, validateAckPayload } from "../src/core/ack.js";
import { sampleCheckpoint, sampleGit, sampleManifest, sampleModel, sampleUntrustedInstructionData } from "./helpers.js";

describe("ack challenge", () => {
  it("accepts matching payload and runtime facts", () => {
    const checkpoint = sampleCheckpoint();
    const payload = parseAckPayload(buildAckTemplate(checkpoint, "target-session", "lease-1"));
    const runtimeFacts = buildRuntimeFacts({
      checkpoint,
      model: sampleModel(),
      git: sampleGit(),
      manifest: sampleManifest(),
      untrustedInstructionData: sampleUntrustedInstructionData(),
    });

    const result = validateAckPayload(checkpoint, payload, runtimeFacts, {
      checkpointId: checkpoint.checkpointId,
      checksum: checkpoint.checksum,
      targetSessionId: "target-session",
      leaseId: "lease-1",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects mismatched checksum, facts, and session binding", () => {
    const checkpoint = sampleCheckpoint();
    const payload = parseAckPayload(
      JSON.stringify({
        checkpointId: checkpoint.checkpointId,
        checksum: "sha256:wrong",
        targetSessionId: "other-session",
        leaseId: "old-lease",
        facts: {
          ...checkpoint.criticalFacts,
          requiredModelId: "forbidden-model",
        },
      }),
    );

    const runtimeFacts = buildRuntimeFacts({
      checkpoint,
      model: sampleModel({ id: "forbidden-model" }),
      git: sampleGit({ statusDigest: "sha256:different" }),
      manifest: sampleManifest(),
      untrustedInstructionData: sampleUntrustedInstructionData({ checksum: "sha256:changed" }),
    });

    const result = validateAckPayload(checkpoint, payload, runtimeFacts, {
      checkpointId: checkpoint.checkpointId,
      checksum: checkpoint.checksum,
      targetSessionId: "target-session",
      leaseId: "lease-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("checksum-mismatch");
    expect(result.errors).toContain("targetSessionId-mismatch");
    expect(result.errors).toContain("leaseId-mismatch");
    expect(result.errors).toContain("facts.requiredModelId");
    expect(result.errors).toContain("runtime-facts.requiredModelId");
  });
});
