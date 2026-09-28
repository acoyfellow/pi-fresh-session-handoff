import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT_RELATIVE_PATH } from "./constants.js";
import type { ThresholdStage } from "./types.js";

export type ReachedThresholdStage = Exclude<ThresholdStage, "below">;

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ThresholdHookEvent {
  stage: ReachedThresholdStage;
  previousStage: ThresholdStage | undefined;
  sessionId: string;
  cwd: string;
  usage: { tokens: number | null; percent: number | null };
  conversation: ConversationTurn[];
}

export interface ThresholdHookTools {
  completeWithCurrentModel(prompt: string): Promise<string>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  signal: AbortSignal;
}

export interface ThresholdHook {
  name: string;
  stages?: ReachedThresholdStage[];
  run(event: ThresholdHookEvent, tools: ThresholdHookTools): Promise<void> | void;
}

export interface HookSpec {
  module: string;
  options?: Record<string, unknown>;
  timeoutMs?: number;
}

export type HookFactory = (options: Record<string, unknown>) => ThresholdHook;

export interface LoadedHook {
  hook: ThresholdHook;
  timeoutMs: number;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

export function globalHookConfigPath(): string {
  return path.join(homedir(), ".pi", "agent", "fresh-session-handoff", "config.json");
}

function parseHookSpecs(raw: unknown): HookSpec[] {
  if (typeof raw !== "object" || raw === null) return [];
  const hooks = (raw as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return [];
  const specs: HookSpec[] = [];
  for (const entry of hooks) {
    if (typeof entry === "string" && entry.trim()) {
      specs.push({ module: entry.trim() });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.module !== "string" || !record.module.trim()) continue;
    specs.push({
      module: record.module.trim(),
      options: typeof record.options === "object" && record.options !== null ? (record.options as Record<string, unknown>) : undefined,
      timeoutMs: typeof record.timeoutMs === "number" && record.timeoutMs > 0 ? record.timeoutMs : undefined,
    });
  }
  return specs;
}

async function readJsonOrUndefined(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function loadHookSpecs(cwd: string, globalConfigPath = globalHookConfigPath()): Promise<Array<HookSpec & { baseDir: string }>> {
  const projectConfigPath = path.join(cwd, ROOT_RELATIVE_PATH, "config.json");
  const globalSpecs = parseHookSpecs(await readJsonOrUndefined(globalConfigPath)).map((spec) => ({ ...spec, baseDir: path.dirname(globalConfigPath) }));
  const projectSpecs = parseHookSpecs(await readJsonOrUndefined(projectConfigPath)).map((spec) => ({ ...spec, baseDir: path.dirname(projectConfigPath) }));
  const seen = new Set<string>();
  return [...globalSpecs, ...projectSpecs].filter((spec) => {
    const key = `${spec.baseDir}:${spec.module}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isThresholdHook(value: unknown): value is ThresholdHook {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.run === "function";
}

export async function instantiateHook(
  spec: HookSpec & { baseDir: string },
  builtins: Record<string, HookFactory>,
): Promise<LoadedHook> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const options = spec.options ?? {};
  const builtin = builtins[spec.module];
  if (builtin) return { hook: builtin(options), timeoutMs };

  const expanded = spec.module.startsWith("~/") ? path.join(homedir(), spec.module.slice(2)) : spec.module;
  const modulePath = path.resolve(spec.baseDir, expanded);
  const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  const exported = loaded.default;
  const hook = typeof exported === "function" ? (exported as HookFactory)(options) : exported;
  if (!isThresholdHook(hook)) throw new Error(`hook module ${spec.module} must export a hook or hook factory`);
  return { hook, timeoutMs };
}

export function hookHandlesStage(hook: ThresholdHook, stage: ReachedThresholdStage): boolean {
  return !hook.stages || hook.stages.length === 0 || hook.stages.includes(stage);
}

export interface HookRunOutcome {
  name: string;
  status: "ok" | "failed" | "timed_out" | "skipped";
  error?: string;
}

export async function runHookWithTimeout(
  loaded: LoadedHook,
  event: ThresholdHookEvent,
  tools: Omit<ThresholdHookTools, "signal">,
): Promise<HookRunOutcome> {
  const { hook, timeoutMs } = loaded;
  if (!hookHandlesStage(hook, event.stage)) return { name: hook.name, status: "skipped" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HookRunOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ name: hook.name, status: "timed_out" });
    }, timeoutMs);
  });
  const execution = (async (): Promise<HookRunOutcome> => {
    try {
      await hook.run(event, { ...tools, signal: controller.signal });
      return { name: hook.name, status: "ok" };
    } catch (error) {
      return { name: hook.name, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  })();
  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SessionEntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function conversationFromEntries(entries: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const raw of entries) {
    const entry = raw as SessionEntryLike;
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromContent(entry.message?.content).trim();
    if (text) turns.push({ role, text });
  }
  return turns;
}
