import type { ModelSnapshot, RequiredModel } from "./types.js";

function normalizeProvider(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "unknown";
}

function normalizeModelId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "unknown";
}

function deriveRoute(provider: string, explicitRoute: unknown): string {
  if (typeof explicitRoute === "string" && explicitRoute.trim().length > 0) {
    return explicitRoute.trim();
  }
  if (provider.toLowerCase().includes("opencode")) {
    return "OpenCode";
  }
  return "unknown";
}

export function snapshotModel(input: unknown): ModelSnapshot {
  const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const provider = normalizeProvider(source.provider ?? source.providerId);
  const id = normalizeModelId(source.id ?? source.modelId);
  const displayName =
    typeof source.name === "string" && source.name.trim().length > 0 ? source.name.trim() : id;
  const route = deriveRoute(provider, source.route);

  return {
    provider,
    id,
    route,
    displayName,
  };
}

function scopedModelSnapshots(scopedModels: unknown[] | undefined): ModelSnapshot[] {
  if (!scopedModels) {
    return [];
  }

  const snapshots: ModelSnapshot[] = [];
  for (const entry of scopedModels) {
    if (typeof entry === "object" && entry !== null) {
      const source = entry as Record<string, unknown>;
      snapshots.push(snapshotModel(source.model ?? source));
    }
  }
  return snapshots;
}

export interface ModelValidationResult {
  ok: boolean;
  reasons: string[];
}

export function matchesRequiredModel(candidate: ModelSnapshot, required: RequiredModel): boolean {
  if (candidate.provider !== required.provider || candidate.id !== required.id) return false;
  return required.route === undefined || candidate.route === required.route;
}

export function renderRequiredModel(required: RequiredModel): string {
  return required.route ? `${required.provider}/${required.id} route=${required.route}` : `${required.provider}/${required.id}`;
}

export function validateRequiredModel(
  activeModel: ModelSnapshot,
  scopedModels: unknown[] | undefined,
  hasRequiredInRegistry: boolean,
  required: RequiredModel | undefined,
): ModelValidationResult {
  if (!required) {
    return { ok: true, reasons: [] };
  }

  const reasons: string[] = [];

  if (activeModel.provider !== required.provider) {
    reasons.push(`active provider must be ${required.provider}`);
  }
  if (activeModel.id !== required.id) {
    reasons.push(`active model must be ${required.id}`);
  }
  if (required.route !== undefined && activeModel.route !== required.route) {
    reasons.push(`active route must be ${required.route}`);
  }

  if (!hasRequiredInRegistry) {
    reasons.push("required model is missing from model registry");
  }

  const scoped = scopedModelSnapshots(scopedModels);
  if (scoped.length > 0 && !scoped.some((candidate) => matchesRequiredModel(candidate, required))) {
    reasons.push("required model is missing from scoped model picker");
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
