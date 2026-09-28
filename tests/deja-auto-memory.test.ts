import { describe, expect, it } from "vitest";

import type { ThresholdHookEvent, ThresholdHookTools } from "../src/core/hooks.js";
import {
  createDejaAutoMemoryHook,
  parseCandidates,
  parseNovelIndexes,
  recentConversationText,
  resolveOptions,
  type DejaClient,
  type MemoryCandidate,
} from "../src/hooks/deja-auto-memory.js";

function event(conversation: ThresholdHookEvent["conversation"]): ThresholdHookEvent {
  return { stage: "prepare", previousStage: "warning", sessionId: "s1", cwd: "/repo", usage: { tokens: 1, percent: 83 }, conversation };
}

function fakeDeja(existing: Record<string, string>) {
  const saved: MemoryCandidate[] = [];
  const client: DejaClient = {
    recall: async (query) => existing[query] ?? "",
    remember: async (candidate) => {
      saved.push(candidate);
      return "drafted";
    },
  };
  return { client, saved };
}

describe("deja auto-memory hook", () => {
  it("parses candidate JSON defensively and dedupes", () => {
    const text = 'Sure:\n{"memories":[{"text":"Project uses Bun for tests.","kind":"preference"},{"text":"project uses bun for tests.","kind":"fact"},{"text":"short","kind":"fact"},{"text":"Deploys go through wrangler.","kind":"bogus"}]}';
    expect(parseCandidates(text, 8)).toEqual([
      { text: "Project uses Bun for tests.", kind: "preference" },
      { text: "Deploys go through wrangler.", kind: "fact" },
    ]);
    expect(parseCandidates("no json", 8)).toEqual([]);
    expect(parseNovelIndexes('{"new":[2,0,0,9,"1"]}', 3)).toEqual([0, 2]);
  });

  it("keeps the most recent conversation within the character budget", () => {
    const text = recentConversationText([{ role: "user", text: "old ".repeat(50) }, { role: "assistant", text: "newest" }], 30);
    expect(text).toBe("Assistant: newest");
  });

  it("extracts, checks against Deja, and saves only novel memories", async () => {
    const prompts: string[] = [];
    const responses = [
      JSON.stringify({ memories: [{ text: "Tests run with bun test, not vitest.", kind: "preference" }, { text: "The API rate limit is 50 requests per second.", kind: "fact" }] }),
      JSON.stringify({ new: [1] }),
    ];
    const notices: string[] = [];
    const tools: ThresholdHookTools = {
      completeWithCurrentModel: async (prompt) => {
        prompts.push(prompt);
        return responses.shift() ?? "";
      },
      notify: (message) => notices.push(message),
      signal: new AbortController().signal,
    };
    const { client, saved } = fakeDeja({ "Tests run with bun test, not vitest.": "[medium] 01X kept\n  tests use bun test" });
    const hook = createDejaAutoMemoryHook({}, client);

    await hook.run(event([{ role: "user", text: "remember we use bun test" }]), tools);

    expect(prompts[0]).toContain("remember we use bun test");
    expect(prompts[1]).toContain("tests use bun test");
    expect(prompts[1]).toContain("(no matches)");
    expect(saved).toEqual([{ text: "The API rate limit is 50 requests per second.", kind: "fact" }]);
    expect(notices).toEqual(["auto-memory (prepare): 1 new saved to Deja as drafts, 1 already known"]);
  });

  it("does nothing for empty conversations or no candidates", async () => {
    let calls = 0;
    const tools: ThresholdHookTools = { completeWithCurrentModel: async () => { calls++; return '{"memories":[]}'; }, notify: () => undefined, signal: new AbortController().signal };
    const { client, saved } = fakeDeja({});
    const hook = createDejaAutoMemoryHook({}, client);
    await hook.run(event([]), tools);
    expect(calls).toBe(0);
    await hook.run(event([{ role: "user", text: "hello" }]), tools);
    expect(calls).toBe(1);
    expect(saved).toEqual([]);
  });

  it("resolves options with safe defaults", () => {
    const options = resolveOptions({ stages: ["force", "bogus"], maxCandidates: 3, dejaCommand: ["deja"] });
    expect(options).toMatchObject({ stages: ["force"], maxCandidates: 3, dejaCommand: ["deja"], author: "pi/auto-memory" });
    expect(resolveOptions({}).stages).toEqual(["warning", "prepare", "force"]);
  });
});
