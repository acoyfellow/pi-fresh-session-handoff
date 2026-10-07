import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SessionPrimerOptions {
  dejaCommand: string[];
  author: string;
  maxTokens: number;
  maxPromptChars: number;
  timeoutMs: number;
}

export const DEFAULT_PRIMER_OPTIONS: SessionPrimerOptions = {
  dejaCommand: ["deja"],
  author: "pi/session-primer",
  maxTokens: 600,
  maxPromptChars: 400,
  timeoutMs: 4_000,
};

export function primerOptionsFrom(raw: Record<string, unknown> | undefined): SessionPrimerOptions {
  const source = raw ?? {};
  const positive = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? Math.floor(value) : fallback);
  const command = Array.isArray(source.dejaCommand) && source.dejaCommand.every((part) => typeof part === "string") && source.dejaCommand.length > 0
    ? (source.dejaCommand as string[])
    : DEFAULT_PRIMER_OPTIONS.dejaCommand;
  return {
    dejaCommand: command,
    author: typeof source.author === "string" && source.author.trim() ? source.author : DEFAULT_PRIMER_OPTIONS.author,
    maxTokens: positive(source.maxTokens, DEFAULT_PRIMER_OPTIONS.maxTokens),
    maxPromptChars: positive(source.maxPromptChars, DEFAULT_PRIMER_OPTIONS.maxPromptChars),
    timeoutMs: positive(source.timeoutMs, DEFAULT_PRIMER_OPTIONS.timeoutMs),
  };
}

export function primerQuery(prompt: string, maxChars: number): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function hasRecallHits(recallOutput: string): boolean {
  return /^\[(high|medium|low)\] [0-9A-Z]{26}\s/m.test(recallOutput);
}

export function primerMessage(recallOutput: string): string {
  return [
    "Deja memory: notes from earlier sessions that may relate to this request.",
    "Each shows where it was made (from: ...). Treat them as leads, not truth: verify mutable facts against live state.",
    "If one helps, call deja signal with kind=used; if one is wrong or stale, kind=wrong.",
    "",
    recallOutput.trim(),
  ].join("\n");
}

export type RecallRunner = (query: string, cwd: string, sessionId: string) => Promise<string>;

export function cliRecallRunner(options: SessionPrimerOptions): RecallRunner {
  const [command, ...prefix] = options.dejaCommand;
  return async (query, cwd, sessionId) => {
    const { stdout } = await execFileAsync(command, [...prefix, "recall", query, `--tokens=${options.maxTokens}`], {
      cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, DEJA_AUTHOR: options.author, DEJA_SESSION: sessionId },
    });
    return stdout;
  };
}

export async function buildPrimer(prompt: string, cwd: string, sessionId: string, options: SessionPrimerOptions, recall: RecallRunner): Promise<string | undefined> {
  const query = primerQuery(prompt, options.maxPromptChars);
  if (!query) return undefined;
  try {
    const output = await recall(query, cwd, sessionId);
    return hasRecallHits(output) ? primerMessage(output) : undefined;
  } catch {
    return undefined;
  }
}
