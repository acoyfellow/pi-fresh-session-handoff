import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ThresholdHookEvent, ThresholdHookTools } from "../src/core/hooks.js";
import {
  createDejaAutoMemoryHook,
  parseCandidates,
  parseNoveltyVerdict,
  draftIdsIn,
  containsPersonalData,
  keptIdsIn,
  extractionPrompt,
  cliDejaClient,
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
  const kept: string[] = [];
  const client: DejaClient = {
    recall: async (query) => existing[query] ?? "",
    remember: async (candidate) => {
      saved.push(candidate);
      return "drafted";
    },
    keep: async (ids) => {
      kept.push(...ids);
      return ids.map((id) => `kept ${id}`).join("\n");
    },
  };
  return { client, saved, kept };
}

const DRAFT_ID = "01M3QBDX8E22QA67HY57Z62B6Z";
const KEPT_ID = "01M0EEHV76D2CDHW88T2FATPFH";

describe("deja auto-memory hook", () => {
  it("parses candidate JSON defensively and dedupes", () => {
    const text = 'Sure:\n{"memories":[{"text":"Project uses Bun for tests.","kind":"preference"},{"text":"project uses bun for tests.","kind":"fact"},{"text":"short","kind":"fact"},{"text":"Deploys go through wrangler.","kind":"bogus"}]}';
    expect(parseCandidates(text, 8)).toEqual([
      { text: "Project uses Bun for tests.", kind: "preference" },
      { text: "Deploys go through wrangler.", kind: "fact" },
    ]);
    expect(parseCandidates("no json", 8)).toEqual([]);
    expect(parseNoveltyVerdict('{"new":[2,0,0,9,"1"]}', 3, new Set()).novel).toEqual([0, 2]);
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

  it("keeps a draft that a later pass finds again", async () => {
    const recalled = `[low] ${DRAFT_ID}  draft    2026-09-29T19:49:22  pi/auto-memory\n  scope: cwd:x\n  WARP blocks uploads.\n\n[medium] ${KEPT_ID}  kept     2026-08-20T02:03:42  pi\n  something else`;
    const responses = [
      JSON.stringify({ memories: [{ text: "WARP blocks uploads to oaiusercontent.com.", kind: "pitfall" }] }),
      JSON.stringify({ new: [], repeatedDrafts: [DRAFT_ID, KEPT_ID, "01NOTRECALLEDXXXXXXXXXXXXX"] }),
    ];
    const notices: string[] = [];
    const tools: ThresholdHookTools = {
      completeWithCurrentModel: async () => responses.shift() ?? "",
      notify: (message) => notices.push(message),
      signal: new AbortController().signal,
    };
    const { client, saved, kept } = fakeDeja({ "WARP blocks uploads to oaiusercontent.com.": recalled });

    await createDejaAutoMemoryHook({}, client).run(event([{ role: "user", text: "warp again" }]), tools);

    expect(saved).toEqual([]);
    expect(kept).toEqual([DRAFT_ID]);
    expect(notices).toEqual(["auto-memory (prepare): 0 new saved to Deja as drafts, 1 already known, 1 repeated drafts kept"]);
  });

  it("finds draft ids only on draft hit lines", () => {
    const text = `[low] ${DRAFT_ID}  draft    2026\n  mentions ${KEPT_ID} draft in text\n[medium] ${KEPT_ID}  kept     2026`;
    expect([...draftIdsIn(text)]).toEqual([DRAFT_ID]);
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


describe("auto-memory privacy and session rules", () => {
  it("drops candidates that carry personal identifiers but keeps engineering facts", () => {
    expect(containsPersonalData("Ticket deletion for user ID `0123456789abcdef0123456789abcdef`")).toBe(true);
    expect(containsPersonalData("Customer jane.doe@example.com asked for deletion")).toBe(true);
    expect(containsPersonalData("account 555000111 has four chats")).toBe(true);
    expect(containsPersonalData("set customer_id=abc123 before replaying")).toBe(true);
    expect(containsPersonalData("ticket for 123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(containsPersonalData("call them on +1 415 555 0134")).toBe(true);
    expect(containsPersonalData("Pi 0.84.4 shipped on 2026-10-05 with wrangler 4.12.0")).toBe(false);
    expect(containsPersonalData("Pin cf 1.0.0-beta.7; released 2026-10-02 in workerd 1.20260801.1")).toBe(false);
    expect(containsPersonalData("Deletion must also clear conversation-linked tables and user-level records.")).toBe(false);

    const parsed = parseCandidates(
      JSON.stringify({ memories: [
        { text: "Privacy request for user ID 0123456789abcdef0123456789abcdef covers four chats.", kind: "fact" },
        { text: "Privacy deletion must also clear conversation-linked tables.", kind: "pitfall" },
      ] }),
      8,
    );
    expect(parsed).toEqual([{ text: "Privacy deletion must also clear conversation-linked tables.", kind: "pitfall" }]);
  });

  it("tells the model never to store third-party personal data", () => {
    expect(extractionPrompt("x", 3)).toContain("Never record personal data about customers");
  });

  it("CLI client recalls without traces and keeps only drafts from another session", async () => {
    const calls: string[][] = [];
    const client = cliDejaClient({ dejaCommand: ["node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))"], author: "pi/auto-memory" });
    const signal = new AbortController().signal;
    calls.push(JSON.parse(await client.recall("q", process.cwd(), "s", signal)));
    calls.push(JSON.parse(await client.keep(["01ABC"], process.cwd(), "s", signal)));
    expect(calls[0]).toEqual(["recall", "q", "--tokens=600", "--no-trace"]);
    expect(calls[1]).toEqual(["keep", "01ABC", "--from-other-session"]);
  });
});

describe("keep output parsing", () => {
  it("counts only ids Deja actually kept", () => {
    const output = "kept 01M3QBDX8E22QA67HY57Z62B6Z\nunchanged (same session) 01M0EEHV76D2CDHW88T2FATPFH\nunchanged 01M3RQVBDQ2685CABHYDQ8YTNN";
    expect(keptIdsIn(output)).toEqual(["01M3QBDX8E22QA67HY57Z62B6Z"]);
  });
});

describe("against the real deja CLI", () => {
  const dejaCli = process.env.DEJA_CLI ?? join(homedir(), "cloudflare", "deja", "src", "cli.ts");
  it.skipIf(!existsSync(dejaCli))("keeps a draft only when another session finds it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsh-deja-"));
    const previousDb = process.env.DEJA_DB;
    process.env.DEJA_DB = join(dir, "deja.db");
    try {
      const client = cliDejaClient({ dejaCommand: ["bun", dejaCli], author: "pi/auto-memory" });
      const signal = new AbortController().signal;
      const saved = await client.remember({ text: "real-cli probe: staging needs --env staging", kind: "procedure" }, dir, "session-a", signal);
      const id = saved.match(/[0-9A-Z]{26}/)![0];
      expect(keptIdsIn(await client.keep([id], dir, "session-a", signal))).toEqual([]);
      expect(keptIdsIn(await client.keep([id], dir, "session-b", signal))).toEqual([id]);
    } finally {
      if (previousDb === undefined) delete process.env.DEJA_DB;
      else process.env.DEJA_DB = previousDb;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
