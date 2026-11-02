import { describe, expect, it } from "vitest";
import { clefProbability, createClefJudge } from "../src/hooks/clef.js";
import {
  buildPrimer,
  DEFAULT_PRIMER_OPTIONS,
  notesUsedInReply,
  parseRecallJson,
  primerOptionsFrom,
  primerQuery,
  primerSkipReason,
  type Judge,
  type RecallNote,
} from "../src/hooks/deja-session-primer.js";
import { assistantTextOf, earlierUserPrompts } from "../src/extension.js";

const DEPLOY: RecallNote = { id: "01KYAPNRVAPH9H3R0FJZWDPTXR", score: -12, text: "Marketing deploy runs deploy.sh and checks health.json", formatted: "[medium] 01KYAPNRVAPH9H3R0FJZWDPTXR  kept\n  Marketing deploy runs deploy.sh" };
const STORM: RecallNote = { id: "01M0000000000000000000STRM", score: -9.5, text: "WebSocket 401 storm traced to stale Access cookies", formatted: "[medium] 01M0000000000000000000STRM  kept\n  WebSocket 401 storm" };
const PROMPT = "deploy the deja marketing site and check health";

const judgeBy = (pick: (state: string) => number): Judge => async (state) => pick(state);
const deployJudge = judgeBy((state) => (state.includes("deploy.sh") ? 0.97 : 0.09));

describe("deja session primer", () => {
  it("queries with the prompt, collapsed and capped", () => {
    expect(primerQuery("  fix\n\nthe   deploy  ", 400)).toBe("fix the deploy");
    expect(primerQuery("x".repeat(500), 400)).toHaveLength(400);
  });

  it("skips bots, tests and short prompts before calling Deja", async () => {
    expect(primerSkipReason("READ-ONLY review of this diff please", DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason("You are a Terrarium child. Build the thing", DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason("reply with exactly ok and nothing else", DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason("From the coordinator, for Jordan: ca !771. Rewrite it", DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason("go", DEFAULT_PRIMER_OPTIONS)).toBe("short");
    expect(primerSkipReason("yes ok do it", DEFAULT_PRIMER_OPTIONS)).toBe("short");
    expect(primerSkipReason("   ", DEFAULT_PRIMER_OPTIONS)).toBe("empty");
    expect(primerSkipReason(PROMPT, DEFAULT_PRIMER_OPTIONS)).toBeUndefined();
    let called = false;
    const recall = async () => {
      called = true;
      return [DEPLOY];
    };
    expect(await buildPrimer("go", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, recall, deployJudge)).toBeUndefined();
    expect(called).toBe(false);
  });

  it("skips eval harness prompts and mid-session replies on the same topic", () => {
    expect(primerSkipReason('<file name="/var/folders/hb/x/T/rbm-abc/cron-1.md"> do the task in this file', DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason('<file name="/home/u/.context/reviews/recipe/ns/2/t.md"> review it now please', DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason('<file name="/Users/u/review-process/eval/results/20261102T124117Z/prompt-30.txt"> You are choosing a candidate', DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason("Finish this small feature and ship it. 1. Add a GET /health route to src/index.ts", DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason("Run 'npm test'. If it passes, reply exactly: DONE.", DEFAULT_PRIMER_OPTIONS)).toBe("automated");
    expect(primerSkipReason('<file name="notes.md"> summarise this design document for me', DEFAULT_PRIMER_OPTIONS)).toBeUndefined();
  });

  it("mid-session, re-primes only when the judge says the topic changed", async () => {
    const earlier = ["refresh the deja dogfood dashboard html with current usage"];
    const topicJudge: Judge = async (state, question) => (question.includes("different task") ? (state.includes("braintrust") ? 0.89 : 0.07) : 0.97);
    const recall = async () => [DEPLOY];
    expect(await buildPrimer("ok dogfood checkin, hows it going can u update the html file", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, recall, topicJudge, new Set(), earlier)).toBeUndefined();
    expect((await buildPrimer("now rotate the braintrust api key and purge the terrarium cache", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, recall, topicJudge, new Set(), earlier))?.notes).toEqual([DEPLOY]);
    expect((await buildPrimer("ok dogfood checkin, hows it going can u update the html file", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, recall, topicJudge, new Set(), []))?.notes).toEqual([DEPLOY]);
    const failing: Judge = async (_state, question) => {
      if (question.includes("different task")) throw new Error("down");
      return 0.97;
    };
    expect(await buildPrimer("now rotate the braintrust api key and purge the terrarium cache", "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, recall, failing, new Set(), earlier)).toBeUndefined();
  });

  it("injects only notes the judge rates relevant", async () => {
    const primer = await buildPrimer(PROMPT, "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => [STORM, DEPLOY], deployJudge);
    expect(primer?.notes.map((note) => note.id)).toEqual([DEPLOY.id]);
    expect(primer?.content).toContain("Marketing deploy runs deploy.sh");
    expect(primer?.content).not.toContain("WebSocket");
    expect(primer?.considered).toBe(2);
  });

  it("injects nothing when no note passes, the judge fails, or there is no judge", async () => {
    const lowJudge = judgeBy(() => 0.2);
    const failingJudge: Judge = async () => {
      throw new Error("clef down");
    };
    expect(await buildPrimer(PROMPT, "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => [STORM], lowJudge)).toBeUndefined();
    expect(await buildPrimer(PROMPT, "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => [DEPLOY], failingJudge)).toBeUndefined();
    expect(await buildPrimer(PROMPT, "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => [DEPLOY], undefined)).toBeUndefined();
  });

  it("does not repeat notes already shown in this session", async () => {
    const shown = new Set([DEPLOY.id]);
    expect(await buildPrimer(PROMPT, "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => [DEPLOY], deployJudge, shown)).toBeUndefined();
  });

  it("never breaks the turn when Deja fails", async () => {
    const primer = await buildPrimer(PROMPT, "/tmp", "s1", DEFAULT_PRIMER_OPTIONS, async () => {
      throw new Error("deja missing");
    }, deployJudge);
    expect(primer).toBeUndefined();
  });

  it("marks a note used when the reply quotes its id or the judge says the reply relied on it", async () => {
    expect(await notesUsedInReply(`Per note ${DEPLOY.id.slice(0, 8)} I ran deploy.sh`, [DEPLOY, STORM], DEFAULT_PRIMER_OPTIONS, undefined)).toEqual([DEPLOY]);
    const relied = judgeBy((state) => (state.includes("deploy.sh and checks") ? 0.9 : 0.1));
    expect(await notesUsedInReply("I ran the deploy script and the health check passed", [DEPLOY, STORM], DEFAULT_PRIMER_OPTIONS, relied)).toEqual([DEPLOY]);
    expect(await notesUsedInReply("", [DEPLOY], DEFAULT_PRIMER_OPTIONS, relied)).toEqual([]);
  });

  it("parses deja recall --json output", () => {
    const stdout = JSON.stringify({ traceId: null, hits: [{ id: DEPLOY.id, score: -12, trust: "medium", from: "deja", text: DEPLOY.text, formatted: DEPLOY.formatted }, { id: 3 }] });
    expect(parseRecallJson(stdout)).toEqual([DEPLOY]);
  });

  it("reads options with safe fallbacks", () => {
    expect(primerOptionsFrom({ dejaCommand: ["bun", "cli.ts"], maxNotes: 2, relevanceFloor: 0.8 })).toMatchObject({ dejaCommand: ["bun", "cli.ts"], maxNotes: 2, relevanceFloor: 0.8, timeoutMs: 4000 });
    expect(primerOptionsFrom({ dejaCommand: [], relevanceFloor: 3, minPromptWords: -1 })).toMatchObject({ dejaCommand: ["deja"], relevanceFloor: 0.7, minPromptWords: 5 });
  });

  it("reads earlier prompts from the saved session so a reload does not look like a new session", () => {
    const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    const entries = [user("one"), assistant("a"), user("two"), { type: "custom_message" }, user("three"), user("four"), user("five"), user("six"), user("now")];
    expect(earlierUserPrompts(entries, "now")).toEqual(["two", "three", "four", "five", "six"]);
    expect(earlierUserPrompts(entries.slice(0, -1), "now")).toEqual(["two", "three", "four", "five", "six"]);
    expect(earlierUserPrompts([], "first")).toEqual([]);
  });

  it("collects assistant text from a run's messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }] },
    ];
    expect(assistantTextOf(messages)).toBe("done");
  });
});

describe("clef judge", () => {
  it("reads the probability and retries once with fresh credentials after a 401", async () => {
    expect(clefProbability({ success: true, result: { answers: { answer: { noul: 0.42 } } } })).toBe(0.42);
    expect(clefProbability({ success: false })).toBeUndefined();
    let loads = 0;
    const calls: string[] = [];
    const credentials = async () => ({ accountId: "acc", token: `t${++loads}` });
    const fetcher = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push(init.headers.authorization);
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef");
      expect(JSON.parse(init.body).questions.answer.instructions).toBe("Q?");
      return calls.length === 1
        ? { status: 401, json: async () => ({ success: false }) }
        : { status: 200, json: async () => ({ success: true, result: { answers: { answer: { noul: 0.91 } } } }) };
    };
    const judge = createClefJudge("@cf/cloudflare/clef", 1000, credentials, fetcher);
    expect(await judge("state", "Q?")).toBe(0.91);
    expect(calls).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("throws without credentials so the primer injects nothing", async () => {
    const judge = createClefJudge("m", 1000, async () => undefined);
    await expect(judge("s", "q")).rejects.toThrow("credentials");
  });
});
