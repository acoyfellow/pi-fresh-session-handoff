import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SessionPrimerOptions {
  dejaCommand: string[];
  author: string;
  maxTokens: number;
  maxPromptChars: number;
  timeoutMs: number;
  minPromptWords: number;
  maxNotes: number;
  relevanceFloor: number;
  usedFloor: number;
  clefModel: string;
  clefTimeoutMs: number;
  automatedPrefixes: string[];
}

export const DEFAULT_AUTOMATED_PREFIXES = [
  "READ-ONLY",
  "You are a Terrarium child",
  "You are Terrarium child",
  "Reply with exactly",
  "Reply ok",
  "Do nothing",
  "Call the ",
  "You are in an empty web project",
  "You are building",
  "[terraloop",
  "terraloop tick",
  "From the coordinator",
];

export const DEFAULT_PRIMER_OPTIONS: SessionPrimerOptions = {
  dejaCommand: ["deja"],
  author: "pi/session-primer",
  maxTokens: 1200,
  maxPromptChars: 400,
  timeoutMs: 4_000,
  minPromptWords: 5,
  maxNotes: 3,
  relevanceFloor: 0.7,
  usedFloor: 0.7,
  clefModel: "@cf/cloudflare/clef",
  clefTimeoutMs: 2_500,
  automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES,
};

export function primerOptionsFrom(raw: Record<string, unknown> | undefined): SessionPrimerOptions {
  const source = raw ?? {};
  const base = DEFAULT_PRIMER_OPTIONS;
  const positive = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? Math.floor(value) : fallback);
  const share = (value: unknown, fallback: number) => (typeof value === "number" && value >= 0 && value <= 1 ? value : fallback);
  const strings = (value: unknown, fallback: string[]) =>
    Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string") ? (value as string[]) : fallback;
  return {
    dejaCommand: strings(source.dejaCommand, base.dejaCommand),
    author: typeof source.author === "string" && source.author.trim() ? source.author : base.author,
    maxTokens: positive(source.maxTokens, base.maxTokens),
    maxPromptChars: positive(source.maxPromptChars, base.maxPromptChars),
    timeoutMs: positive(source.timeoutMs, base.timeoutMs),
    minPromptWords: positive(source.minPromptWords, base.minPromptWords),
    maxNotes: positive(source.maxNotes, base.maxNotes),
    relevanceFloor: share(source.relevanceFloor, base.relevanceFloor),
    usedFloor: share(source.usedFloor, base.usedFloor),
    clefModel: typeof source.clefModel === "string" && source.clefModel.trim() ? source.clefModel : base.clefModel,
    clefTimeoutMs: positive(source.clefTimeoutMs, base.clefTimeoutMs),
    automatedPrefixes: strings(source.automatedPrefixes, base.automatedPrefixes),
  };
}

export function primerQuery(prompt: string, maxChars: number): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export type PrimerSkipReason = "empty" | "automated" | "short";

export function primerSkipReason(prompt: string, options: SessionPrimerOptions): PrimerSkipReason | undefined {
  const text = prompt.trim();
  if (!text) return "empty";
  const lowered = text.toLowerCase();
  if (options.automatedPrefixes.some((prefix) => lowered.startsWith(prefix.toLowerCase()))) return "automated";
  if (text.split(/\s+/).length < options.minPromptWords) return "short";
  return undefined;
}

export interface RecallNote {
  id: string;
  score: number;
  text: string;
  formatted: string;
}

export function parseRecallJson(stdout: string): RecallNote[] {
  const parsed = JSON.parse(stdout) as { hits?: unknown };
  if (!Array.isArray(parsed.hits)) return [];
  return parsed.hits.flatMap((hit) => {
    const candidate = hit as Partial<RecallNote>;
    return typeof candidate.id === "string" && typeof candidate.text === "string" && typeof candidate.formatted === "string"
      ? [{ id: candidate.id, score: typeof candidate.score === "number" ? candidate.score : 0, text: candidate.text, formatted: candidate.formatted }]
      : [];
  });
}

export type RecallRunner = (query: string, cwd: string, sessionId: string) => Promise<RecallNote[]>;

export type Judge = (state: string, question: string) => Promise<number>;

export type SignalRunner = (id: string, cwd: string) => Promise<void>;

export const RELEVANCE_QUESTION = "Would this memory note help an agent handle this exact user request?";

export const USED_QUESTION = "Did the agent's reply rely on this memory note?";

export function relevanceState(prompt: string, note: RecallNote): string {
  return `User request: ${prompt}\n\nMemory note: ${note.text.slice(0, 1500)}`;
}

export function usedState(reply: string, note: RecallNote): string {
  return `Memory note: ${note.text.slice(0, 1500)}\n\nAgent reply: ${reply.slice(-4000)}`;
}

export function primerMessage(notes: RecallNote[]): string {
  return [
    "Deja memory: notes from earlier sessions that match this request.",
    "Each shows where it was made (from: ...). Treat them as leads, not truth: verify mutable facts against live state.",
    "",
    ...notes.map((note) => note.formatted.trim()),
  ].join("\n\n");
}

export interface PrimerResult {
  content: string;
  notes: RecallNote[];
  considered: number;
}

export async function selectRelevant(prompt: string, candidates: RecallNote[], options: SessionPrimerOptions, judge: Judge | undefined): Promise<RecallNote[]> {
  if (!judge) return [];
  try {
    const scores = await Promise.all(candidates.map((note) => judge(relevanceState(prompt, note), RELEVANCE_QUESTION)));
    return candidates
      .map((note, index) => ({ note, probability: scores[index] }))
      .filter((entry) => entry.probability >= options.relevanceFloor)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, options.maxNotes)
      .map((entry) => entry.note);
  } catch {
    return [];
  }
}

export async function buildPrimer(
  prompt: string,
  cwd: string,
  sessionId: string,
  options: SessionPrimerOptions,
  recall: RecallRunner,
  judge: Judge | undefined,
  alreadyShown: ReadonlySet<string> = new Set(),
): Promise<PrimerResult | undefined> {
  if (primerSkipReason(prompt, options)) return undefined;
  const query = primerQuery(prompt, options.maxPromptChars);
  try {
    const candidates = (await recall(query, cwd, sessionId)).filter((note) => !alreadyShown.has(note.id)).slice(0, options.maxNotes * 2);
    if (candidates.length === 0) return undefined;
    const notes = await selectRelevant(query, candidates, options, judge);
    if (notes.length === 0) return undefined;
    return { content: primerMessage(notes), notes, considered: candidates.length };
  } catch {
    return undefined;
  }
}

export async function notesUsedInReply(reply: string, notes: RecallNote[], options: SessionPrimerOptions, judge: Judge | undefined): Promise<RecallNote[]> {
  const text = reply.trim();
  if (!text || notes.length === 0) return [];
  const quoted = notes.filter((note) => text.includes(note.id) || text.includes(note.id.slice(0, 8)));
  const rest = notes.filter((note) => !quoted.includes(note));
  if (!judge || rest.length === 0) return quoted;
  try {
    const scores = await Promise.all(rest.map((note) => judge(usedState(text, note), USED_QUESTION)));
    return [...quoted, ...rest.filter((_, index) => scores[index] >= options.usedFloor)];
  } catch {
    return quoted;
  }
}

export function cliRecallRunner(options: SessionPrimerOptions): RecallRunner {
  const [command, ...prefix] = options.dejaCommand;
  return async (query, cwd, sessionId) => {
    const { stdout } = await execFileAsync(command, [...prefix, "recall", query, `--tokens=${options.maxTokens}`, "--json"], {
      cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, DEJA_AUTHOR: options.author, DEJA_SESSION: sessionId },
    });
    return parseRecallJson(stdout);
  };
}

export function cliSignalRunner(options: SessionPrimerOptions): SignalRunner {
  const [command, ...prefix] = options.dejaCommand;
  return async (id, cwd) => {
    await execFileAsync(command, [...prefix, "signal", id, "used"], {
      cwd,
      timeout: options.timeoutMs,
      env: { ...process.env, DEJA_AUTHOR: options.author },
    });
  };
}
