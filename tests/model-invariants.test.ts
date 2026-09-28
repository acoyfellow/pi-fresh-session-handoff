import { describe, expect, it } from "vitest";

import { snapshotModel, validateRequiredModel } from "../src/core/model.js";
import type { RequiredModel } from "../src/core/types.js";

const required: RequiredModel = { provider: "example-provider", id: "example-model", route: "example-route" };

describe("model invariants", () => {
  it("accepts any model when the manifest pins none", () => {
    const active = snapshotModel({ provider: "anything", id: "whatever" });
    expect(validateRequiredModel(active, undefined, false, undefined)).toEqual({ ok: true, reasons: [] });
  });

  it("accepts exact required model", () => {
    const active = snapshotModel({ provider: "example-provider", id: "example-model", route: "example-route", name: "Example Model" });
    const result = validateRequiredModel(active, [{ model: { ...required } }], true, required);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects model substitution", () => {
    const active = snapshotModel({ provider: "example-provider", id: "forbidden-model", route: "example-route" });
    const result = validateRequiredModel(active, undefined, true, required);
    expect(result.ok).toBe(false);
    expect(result.reasons.join("|")).toContain("example-model");
  });

  it("rejects scoped picker without required model", () => {
    const active = snapshotModel({ ...required });
    const result = validateRequiredModel(active, [{ model: { provider: "example-provider", id: "example-other-model", route: "example-route" } }], true, required);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("required model is missing from scoped model picker");
  });

  it("ignores route when the manifest does not specify one", () => {
    const active = snapshotModel({ provider: "example-provider", id: "example-model", route: "any-route" });
    expect(validateRequiredModel(active, undefined, true, { provider: "example-provider", id: "example-model" }).ok).toBe(true);
  });

  it("reports a pinned model missing from the registry", () => {
    const active = snapshotModel({ ...required });
    expect(validateRequiredModel(active, undefined, false, required).reasons).toContain("required model is missing from model registry");
  });
});
