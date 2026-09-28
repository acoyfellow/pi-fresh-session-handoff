import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  conversationFromEntries,
  instantiateHook,
  loadHookSpecs,
  runHookWithTimeout,
  type ThresholdHookEvent,
} from "../src/core/hooks.js";

const baseEvent: ThresholdHookEvent = {
  stage: "warning",
  previousStage: "below",
  sessionId: "session-1",
  cwd: "/tmp",
  usage: { tokens: 1, percent: 71 },
  conversation: [],
};

const tools = { completeWithCurrentModel: async () => "", notify: () => undefined };

describe("threshold hooks", () => {
  it("merges global and project hook specs, accepting strings and objects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fsh-hooks-"));
    const globalConfig = path.join(root, "global", "config.json");
    await mkdir(path.dirname(globalConfig), { recursive: true });
    await writeFile(globalConfig, JSON.stringify({ hooks: ["deja-auto-memory"] }));
    const projectDir = path.join(root, "project", ".pi", "fresh-session-handoff");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "config.json"), JSON.stringify({ hooks: [{ module: "./mine.mjs", timeoutMs: 5, options: { a: 1 } }, 42] }));

    const specs = await loadHookSpecs(path.join(root, "project"), globalConfig);
    expect(specs.map((spec) => spec.module)).toEqual(["deja-auto-memory", "./mine.mjs"]);
    expect(specs[1]).toMatchObject({ timeoutMs: 5, options: { a: 1 }, baseDir: projectDir });
  });

  it("loads user hook modules exporting a factory relative to the config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fsh-hook-module-"));
    await writeFile(path.join(dir, "hook.mjs"), "export default (options) => ({ name: 'custom-' + options.suffix, run() {} });");
    const loaded = await instantiateHook({ module: "./hook.mjs", options: { suffix: "x" }, baseDir: dir }, {});
    expect(loaded.hook.name).toBe("custom-x");
  });

  it("rejects modules that do not export a hook", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fsh-hook-bad-"));
    await writeFile(path.join(dir, "bad.mjs"), "export default 7;");
    await expect(instantiateHook({ module: "./bad.mjs", baseDir: dir }, {})).rejects.toThrow(/must export/);
  });

  it("isolates hook failures, timeouts, and unhandled stages", async () => {
    const failing = await runHookWithTimeout({ hook: { name: "f", run: () => { throw new Error("boom"); } }, timeoutMs: 1000 }, baseEvent, tools);
    expect(failing).toEqual({ name: "f", status: "failed", error: "boom" });

    let aborted = false;
    const slow = await runHookWithTimeout(
      { hook: { name: "s", run: (_event, hookTools) => new Promise<void>((resolve) => hookTools.signal.addEventListener("abort", () => { aborted = true; resolve(); })) }, timeoutMs: 10 },
      baseEvent,
      tools,
    );
    expect(slow.status).toBe("timed_out");
    expect(aborted).toBe(true);

    const skipped = await runHookWithTimeout({ hook: { name: "p", stages: ["force"], run: () => undefined }, timeoutMs: 10 }, baseEvent, tools);
    expect(skipped.status).toBe("skipped");
  });

  it("extracts user and assistant text from session entries", () => {
    const turns = conversationFromEntries([
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", name: "bash" }] } },
      { type: "message", message: { role: "toolResult", content: "ignored" } },
      { type: "custom" },
    ]);
    expect(turns).toEqual([{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }]);
  });
});

describe("hook shutdown", () => {
  it("waits for a running hook batch before shutdown completes", async () => {
    const { default: createExtension } = await import("../src/extension.js");
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    createExtension({ on: (name: string, handler: never) => { handlers[name] = handler; }, registerCommand: () => undefined } as never);
    expect(typeof handlers.session_shutdown).toBe("function");

    const { waitForRunningHooks } = await import("../src/extension.js");
    expect(await waitForRunningHooks("no-such-session", 10)).toBe(true);
  });
});
