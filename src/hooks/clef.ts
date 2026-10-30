import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Judge } from "./deja-session-primer.js";

const execFileAsync = promisify(execFile);

export interface ClefCredentials {
  accountId: string;
  token: string;
}

export type CredentialSource = () => Promise<ClefCredentials | undefined>;

export type ClefFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").pop()?.trim() || undefined;
}

function firstAccountId(whoami: string): string | undefined {
  try {
    const parsed = JSON.parse(whoami.slice(whoami.indexOf("{"))) as { accounts?: Array<{ id?: unknown }> };
    const id = parsed.accounts?.[0]?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

async function wrangler(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("wrangler", args, { timeout: 15_000, encoding: "utf8" });
  return stdout;
}

export function wranglerCredentials(env: NodeJS.ProcessEnv = process.env): CredentialSource {
  return async () => {
    try {
      const token = env.DEJA_CLEF_TOKEN ?? env.WRITE_JUDGE_TOKEN ?? lastLine(await wrangler(["auth", "token"]));
      const accountId = env.DEJA_CLEF_ACCOUNT_ID ?? env.WRITE_JUDGE_ACCOUNT_ID ?? firstAccountId(await wrangler(["whoami", "--json"]));
      return token && accountId ? { token, accountId } : undefined;
    } catch {
      return undefined;
    }
  };
}

export function clefProbability(reply: unknown): number | undefined {
  const body = reply as { success?: unknown; result?: { answers?: Record<string, { noul?: unknown }> } };
  const value = body.success === true ? body.result?.answers?.answer?.noul : undefined;
  return typeof value === "number" ? value : undefined;
}

export function createClefJudge(model: string, timeoutMs: number, credentials: CredentialSource, fetcher: ClefFetch = fetch as unknown as ClefFetch): Judge {
  let cached: Promise<ClefCredentials | undefined> | undefined;
  const load = (refresh: boolean) => {
    if (refresh || !cached) cached = credentials();
    return cached;
  };
  const ask = async (state: string, question: string, refresh: boolean): Promise<number> => {
    const creds = await load(refresh);
    if (!creds) throw new Error("clef credentials unavailable");
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
      body: JSON.stringify({ state, questions: { answer: { type: "noul", instructions: question } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((response.status === 401 || response.status === 403) && !refresh) return ask(state, question, true);
    const probability = clefProbability(await response.json());
    if (probability === undefined) throw new Error(`clef call failed (${response.status})`);
    return probability;
  };
  return (state, question) => ask(state, question, false);
}
