import { describe, expect, it } from "vitest";

import { hasDisallowedShellSyntax, shouldBlockForAck } from "../src/core/mutation-guard.js";

describe("ack-before-edit guard", () => {
  it("blocks mutating and unknown tools when ack is required", () => {
    expect(shouldBlockForAck(true, "write", { path: "x", content: "y" })).toBe(true);
    expect(shouldBlockForAck(true, "edit", { path: "x", edits: [] })).toBe(true);
    expect(shouldBlockForAck(true, "hashline", { patch: "x" })).toBe(true);
    expect(shouldBlockForAck(true, "custom_mutator", { payload: "x" })).toBe(true);
  });

  it("blocks shell control operators, redirection, and substitutions", () => {
    expect(hasDisallowedShellSyntax("echo hacked > x.txt")).toBe(true);
    expect(shouldBlockForAck(true, "bash", { command: "echo hacked > x.txt" })).toBe(true);
    expect(shouldBlockForAck(true, "bash", { command: "git status; touch x.txt" })).toBe(true);
    expect(shouldBlockForAck(true, "bash", { command: "cat /etc/hosts > x.txt" })).toBe(true);
    expect(shouldBlockForAck(true, "bash", { command: "npm run test && touch x" })).toBe(true);
    expect(shouldBlockForAck(true, "bash", { command: "cat $(pwd)/file.txt" })).toBe(true);
  });

  it("allows only explicit read-only operations while ack is required", () => {
    expect(shouldBlockForAck(true, "read", { path: "README.md" })).toBe(false);
    expect(shouldBlockForAck(true, "bash", { command: "git status" })).toBe(false);
    expect(shouldBlockForAck(true, "bash", { command: "pwd" })).toBe(false);
  });

  it("allows all tools after ack", () => {
    expect(shouldBlockForAck(false, "write", { path: "x", content: "y" })).toBe(false);
  });
});
