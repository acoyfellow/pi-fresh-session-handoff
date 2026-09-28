import { describe, expect, it } from "vitest";

import { buildRedactionReport } from "../src/core/redaction.js";

describe("redaction", () => {
  it("removes secret-like keys and keeps safe key names only", () => {
    const report = buildRedactionReport({
      API_KEY: "secret",
      PATH: "/bin",
      PI_CODING_AGENT_DIR: "/tmp/pi",
      CUSTOM_TOKEN: "token",
      HOME: "/Users/test",
    });

    expect(report.removedEnvKeys).toContain("API_KEY");
    expect(report.removedEnvKeys).toContain("CUSTOM_TOKEN");
    expect(report.keptEnvKeys).toContain("PATH");
    expect(report.keptEnvKeys).toContain("PI_CODING_AGENT_DIR");
    expect(report.transcriptStored).toBe(false);
    expect(report.toolOutputsStored).toBe(false);
    expect(report.assistantReasoningStored).toBe(false);
  });
});
