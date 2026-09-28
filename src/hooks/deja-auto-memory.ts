import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ConversationTurn, HookFactory, ReachedThresholdStage, ThresholdHook, ThresholdHookEvent, ThresholdHookTools } from "../core/hooks.js";

const execFileAsync = promisify(execFile);

export const MEMORY_KINDS = ["decision", "preference", "pitfall", "fact", "procedure"] as const;
export type AutoMemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryCandidate {
  text: string;
  kind: AutoMemoryKind;
}

export interface DejaAutoMemoryOptions {
  dejaCommand: string[];
  stages: ReachedThresholdStage[];
  maxCandidates: number;
  maxConversationChars: number;
  author: string;
}

export interface DejaClient {
  recall(query: string, cwd: string, sessionId: string, signal: AbortSignal): Promise<string>;
  remember(candidate: MemoryCandidate, cwd: string, sessionId: string, signal: AbortSignal): Promise<string>;
}

function defaultDejaCommand(): string[] {
  return ["deja"];
}

export function resolveOptions(raw: Record<string, unknown>): DejaAutoMemoryOptions {
  const command = Array.isArray(raw.dejaCommand) && raw.dejaCommand.every((part) => typeof part === "string") && raw.dejaCommand.length > 0
    ? (raw.dejaCommand as string[])
    : defaultDejaCommand();
  const stages = Array.isArray(raw.stages)
    ? (raw.stages.filter((stage) => stage === "warning" || stage === "prepare" || stage === "force") as ReachedThresholdStage[])
    : [];
  return {
    dejaCommand: command,
    stages: stages.length > 0 ? stages : ["warning", "prepare", "force"],
    maxCandidates: typeof raw.maxCandidates === "number" && raw.maxCandidates > 0 ? Math.floor(raw.maxCandidates) : 8,
    maxConversationChars: typeof raw.maxConversationChars === "number" && raw.maxConversationChars > 0 ? Math.floor(raw.maxConversationChars) : 60_000,
    author: typeof raw.author === "string" && raw.author.trim() ? raw.author.trim() : "pi/auto-memory",
  };
}

export function recentConversationText(conversation: ConversationTurn[], maxChars: number): string {
  const selected: string[] = [];
  let used = 0;
  for (let index = conversation.length - 1; index >= 0; index--) {
    const turn = conversation[index];
    const block = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`;
    if (used + block.length > maxChars) {
      if (selected.length === 0) selected.push(block.slice(block.length - maxChars));
      break;
    }
    selected.push(block);
    used += block.length + 2;
  }
  return selected.reverse().join("\n\n");
}

export function extractionPrompt(conversationText: string, maxCandidates: number): string {
  return [
    "You maintain durable memory for a coding agent. Read the conversation excerpt and extract at most",
    `${maxCandidates} memories that a future agent session in this repository would genuinely benefit from.`,
    "",
    "Keep only durable knowledge: decisions and their reasons, user preferences, pitfalls/gotchas, stable facts",
    "about the codebase or environment, and reusable procedures. Skip transient progress, chit-chat, secrets,",
    "credentials, tokens, and anything that is only true for this moment.",
    "",
    "Each memory must be one self-contained sentence or two, understandable without this conversation.",
    `kind must be one of: ${MEMORY_KINDS.join(", ")}.`,
    "",
    'Respond with only JSON: {"memories":[{"text":"...","kind":"fact"}]}. Use {"memories":[]} if nothing qualifies.',
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
  ].join("\n");
}

export function noveltyPrompt(candidates: MemoryCandidate[], recalled: string[]): string {
  const sections = candidates.map((candidate, index) =>
    [`<candidate index="${index}">`, candidate.text, "</candidate>", "<existing>", recalled[index]?.trim() || "(no matches)", "</existing>"].join("\n"),
  );
  return [
    "For each candidate memory, decide whether it adds information not already captured by the existing memories",
    "shown with it. A candidate is NOT new if an existing memory states the same thing, even in different words.",
    "A candidate IS new if it adds a meaningful detail, or updates or contradicts an existing memory.",
    "",
    'Respond with only JSON: {"new":[0,2]} listing the indexes of new candidates.',
    "",
    ...sections,
  ].join("\n");
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function parseCandidates(text: string, maxCandidates: number): MemoryCandidate[] {
  const parsed = firstJsonObject(text) as { memories?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.memories)) return [];
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const item of parsed.memories) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const memoryText = typeof record.text === "string" ? record.text.trim().replace(/\s+/g, " ") : "";
    if (memoryText.length < 12) continue;
    const key = memoryText.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = MEMORY_KINDS.includes(record.kind as AutoMemoryKind) ? (record.kind as AutoMemoryKind) : "fact";
    candidates.push({ text: memoryText, kind });
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

export function parseNovelIndexes(text: string, candidateCount: number): number[] {
  const parsed = firstJsonObject(text) as { new?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.new)) return [];
  const indexes = parsed.new.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < candidateCount);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

export function cliDejaClient(options: Pick<DejaAutoMemoryOptions, "dejaCommand" | "author">): DejaClient {
  const [command, ...prefix] = options.dejaCommand;
  const run = async (args: string[], cwd: string, sessionId: string, signal: AbortSignal) => {
    const { stdout } = await execFileAsync(command, [...prefix, ...args], {
      cwd,
      signal,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DEJA_AUTHOR: options.author, DEJA_SESSION: sessionId },
    });
    return stdout;
  };
  return {
    recall: (query, cwd, sessionId, signal) => run(["recall", query, "--tokens=600"], cwd, sessionId, signal),
    remember: (candidate, cwd, sessionId, signal) => run(["remember", candidate.text, `--kind=${candidate.kind}`], cwd, sessionId, signal),
  };
}

export interface AutoMemoryReport {
  candidates: number;
  saved: MemoryCandidate[];
  known: number;
}

export async function runAutoMemory(
  event: ThresholdHookEvent,
  tools: ThresholdHookTools,
  options: DejaAutoMemoryOptions,
  deja: DejaClient,
): Promise<AutoMemoryReport> {
  const conversationText = recentConversationText(event.conversation, options.maxConversationChars);
  if (!conversationText.trim()) return { candidates: 0, saved: [], known: 0 };

  const candidates = parseCandidates(await tools.completeWithCurrentModel(extractionPrompt(conversationText, options.maxCandidates)), options.maxCandidates);
  if (candidates.length === 0) return { candidates: 0, saved: [], known: 0 };

  const recalled: string[] = [];
  for (const candidate of candidates) recalled.push(await deja.recall(candidate.text, event.cwd, event.sessionId, tools.signal));

  const novel = parseNovelIndexes(await tools.completeWithCurrentModel(noveltyPrompt(candidates, recalled)), candidates.length);
  const saved: MemoryCandidate[] = [];
  for (const index of novel) {
    if (tools.signal.aborted) break;
    await deja.remember(candidates[index], event.cwd, event.sessionId, tools.signal);
    saved.push(candidates[index]);
  }
  return { candidates: candidates.length, saved, known: candidates.length - novel.length };
}

export function createDejaAutoMemoryHook(rawOptions: Record<string, unknown>, deja?: DejaClient): ThresholdHook {
  const options = resolveOptions(rawOptions);
  const client = deja ?? cliDejaClient(options);
  return {
    name: "deja-auto-memory",
    stages: options.stages,
    async run(event, tools) {
      const report = await runAutoMemory(event, tools, options, client);
      if (report.candidates === 0) return;
      tools.notify(`auto-memory (${event.stage}): ${report.saved.length} new saved to Deja as drafts, ${report.known} already known`, "info");
    },
  };
}

export const dejaAutoMemoryFactory: HookFactory = (options) => createDejaAutoMemoryHook(options);
