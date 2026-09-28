import { readFile } from "node:fs/promises";

import { DEFAULT_CHECKPOINT_TTL_MINUTES } from "./constants.js";
import type { RequiredModel, TaskManifestV1 } from "./types.js";
import { normalizeStringArray, sortUnique } from "./utils.js";

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid manifest field ${field}`);
  }
  return value.trim();
}

function toStringRecord(value: unknown, field: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid manifest field ${field}`);
  }

  const output: Record<string, string> = {};
  for (const [key, recordValue] of Object.entries(value)) {
    if (typeof recordValue !== "string") {
      throw new Error(`Invalid manifest semantic fact ${key}`);
    }
    output[key] = recordValue;
  }
  return output;
}

function normalizedStringList(value: unknown): string[] {
  return sortUnique(normalizeStringArray(value));
}

function parseRequiredModel(raw: unknown): RequiredModel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid manifest field requiredModel");
  }
  const source = raw as Record<string, unknown>;
  const route = source.route;
  if (route !== undefined && (typeof route !== "string" || route.trim().length === 0)) {
    throw new Error("Invalid manifest field requiredModel.route");
  }
  return {
    provider: assertString(source.provider, "requiredModel.provider"),
    id: assertString(source.id, "requiredModel.id"),
    ...(typeof route === "string" ? { route: route.trim() } : {}),
  };
}

export function parseTaskManifest(raw: unknown): TaskManifestV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Manifest must be an object");
  }

  const source = raw as Record<string, unknown>;
  const manifestVersion = assertString(source.manifestVersion, "manifestVersion");
  if (manifestVersion !== "1") {
    throw new Error(`Unsupported manifest version ${manifestVersion}`);
  }

  const requiredModel = parseRequiredModel(source.requiredModel);

  const expiresRaw = source.expiresMinutes;
  const expiresMinutes =
    typeof expiresRaw === "number" && Number.isFinite(expiresRaw) && expiresRaw > 0
      ? Math.floor(expiresRaw)
      : DEFAULT_CHECKPOINT_TTL_MINUTES;

  return {
    manifestVersion: "1",
    taskId: assertString(source.taskId, "taskId"),
    title: assertString(source.title, "title"),
    summary: assertString(source.summary, "summary"),
    ...(requiredModel ? { requiredModel } : {}),
    semanticFacts: toStringRecord(source.semanticFacts ?? {}, "semanticFacts"),
    protectedPaths: normalizedStringList(source.protectedPaths),
    testCommand: assertString(source.testCommand, "testCommand"),
    finalProofCommand: assertString(source.finalProofCommand, "finalProofCommand"),
    forbiddenModels: normalizedStringList(source.forbiddenModels),
    untrustedInstructionPaths: normalizedStringList(source.untrustedInstructionPaths),
    expiresMinutes,
  };
}

export async function loadTaskManifest(path: string): Promise<TaskManifestV1> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseTaskManifest(raw);
}
