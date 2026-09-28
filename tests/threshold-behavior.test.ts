import { describe, expect, it } from "vitest";

import { evaluateThreshold, shouldNotifyThresholdTransition } from "../src/core/thresholds.js";
import type { ThresholdConfig } from "../src/core/types.js";

const config: ThresholdConfig = {
  warningPercent: 70,
  preparePercent: 82,
  forcePercent: 92,
  warningTokens: 180000,
  prepareTokens: 210000,
  forceTokens: 240000,
};

describe("threshold behavior", () => {
  it("derives stage from percent or tokens", () => {
    expect(evaluateThreshold({ tokens: 100000, percent: 60 }, config)).toBe("below");
    expect(evaluateThreshold({ tokens: 181000, percent: 60 }, config)).toBe("warning");
    expect(evaluateThreshold({ tokens: 150000, percent: 83 }, config)).toBe("prepare");
    expect(evaluateThreshold({ tokens: 241000, percent: 80 }, config)).toBe("force");
  });

  it("notifies only on upward transitions", () => {
    expect(shouldNotifyThresholdTransition(undefined, "warning")).toBe(true);
    expect(shouldNotifyThresholdTransition("warning", "prepare")).toBe(true);
    expect(shouldNotifyThresholdTransition("prepare", "warning")).toBe(false);
    expect(shouldNotifyThresholdTransition("force", "force")).toBe(false);
  });
});
