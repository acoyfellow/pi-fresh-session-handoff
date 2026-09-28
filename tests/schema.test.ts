import { describe, expect, it } from "vitest";

import { validateCheckpointSchema } from "../src/core/schema.js";
import { verifyCheckpointChecksum } from "../src/core/checkpoint.js";
import { sampleCheckpoint } from "./helpers.js";

describe("checkpoint schema", () => {
  it("contains required core fields", () => {
    const checkpoint = sampleCheckpoint();

    expect(checkpoint.session.sessionId).toBe("session-1");
    expect(checkpoint.git.branch).toBe("main");
    expect(checkpoint.git.commit).toBe("1234567890abcdef");
    expect(checkpoint.git.status.length).toBeGreaterThan(0);
    expect(checkpoint.git.untracked.length).toBeGreaterThan(0);
    expect(checkpoint.taskManifest.manifestVersion).toBe("1");
    expect(checkpoint.taskManifest.testCommand).toBe("npm test");
    expect(checkpoint.taskManifest.finalProofCommand).toBe("npm run proof");
    expect(checkpoint.model.id).toBe("example-model");
    expect(checkpoint.model.route).toBe("example-route");
    expect(checkpoint.untrustedInstructionData.length).toBeGreaterThan(0);
    expect(checkpoint.criticalFacts.untrustedInstructionDataDigest).toMatch(/^sha256:/);
  });

  it("validates schema and checksum", () => {
    const checkpoint = sampleCheckpoint();
    expect(validateCheckpointSchema(checkpoint)).toEqual([]);
    expect(verifyCheckpointChecksum(checkpoint)).toBe(true);
  });
});

describe("task manifest requiredModel", () => {
  it("is optional and validated when present", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { loadTaskManifest } = await import("../src/core/task-manifest.js");
    const { sampleManifest } = await import("./helpers.js");
    const dir = await mkdtemp(path.join(tmpdir(), "fsh-manifest-"));
    const file = path.join(dir, "manifest.json");
    const { requiredModel: _omitted, ...withoutModel } = sampleManifest();

    await writeFile(file, JSON.stringify(withoutModel));
    expect((await loadTaskManifest(file)).requiredModel).toBeUndefined();

    await writeFile(file, JSON.stringify({ ...withoutModel, requiredModel: { provider: "p", id: "m" } }));
    expect((await loadTaskManifest(file)).requiredModel).toEqual({ provider: "p", id: "m" });

    await writeFile(file, JSON.stringify({ ...withoutModel, requiredModel: "p/m" }));
    await expect(loadTaskManifest(file)).rejects.toThrow(/requiredModel/);
  });
});
