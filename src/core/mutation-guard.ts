import { sortUnique } from "./utils.js";

const readOnlyTools = new Set(["read"]);
const explicitMutatingTools = new Set(["write", "edit", "hashline"]);

const disallowedShellSyntax = /(;|&&|\|\||\||>|<|`|\$\(|\$\{|\n|\r)/;
const safeArg = "[A-Za-z0-9_./:=@,+-]+";
const readOnlyBashPatterns = [
  new RegExp(`^pwd$`),
  new RegExp(`^ls(?:\\s+${safeArg})*$`),
  new RegExp(`^find(?:\\s+${safeArg})+$`),
  new RegExp(`^rg(?:\\s+${safeArg})+$`),
  new RegExp(`^grep(?:\\s+${safeArg})+$`),
  new RegExp(`^head(?:\\s+${safeArg})+$`),
  new RegExp(`^tail(?:\\s+${safeArg})+$`),
  new RegExp(`^cat(?:\\s+${safeArg})+$`),
  new RegExp(`^git\\s+status(?:\\s+${safeArg})*$`),
  new RegExp(`^git\\s+rev-parse(?:\\s+${safeArg})+$`),
  new RegExp(`^git\\s+branch(?:\\s+${safeArg})*$`),
  new RegExp(`^git\\s+diff(?:\\s+${safeArg})*$`),
];

export type ToolAssessmentKind = "read-only" | "mutating" | "unknown";

export interface ToolAssessment {
  kind: ToolAssessmentKind;
  reason: string;
  explicitMutationPaths: string[] | null;
}

function commandFromInput(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "";
  }
  const source = input as { command?: unknown };
  return typeof source.command === "string" ? source.command.trim() : "";
}

function inputPath(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const source = input as { path?: unknown };
  if (typeof source.path !== "string" || source.path.trim().length === 0) {
    return null;
  }
  return [source.path.trim()];
}

function parseHashlinePaths(patch: string): string[] | null {
  const lines = patch.split(/\r?\n/);
  const paths: string[] = [];

  for (const line of lines) {
    const sectionMatch = line.match(/^\[([^\]#]+)(?:#[^\]]+)?\]$/);
    if (sectionMatch) {
      const sectionPath = sectionMatch[1]?.trim();
      if (sectionPath) {
        paths.push(sectionPath);
      }
      continue;
    }

    if (!line.startsWith("MV ")) {
      continue;
    }

    const rawDestination = line.slice(3).trim();
    if (!rawDestination) {
      continue;
    }

    if (rawDestination.startsWith('"') && rawDestination.endsWith('"') && rawDestination.length > 1) {
      paths.push(rawDestination.slice(1, -1));
      continue;
    }

    paths.push(rawDestination);
  }

  const normalized = sortUnique(paths.map((value) => value.trim()).filter((value) => value.length > 0));
  return normalized.length > 0 ? normalized : null;
}

function hashlinePathsFromInput(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const source = input as { patch?: unknown };
  if (typeof source.patch !== "string" || source.patch.trim().length === 0) {
    return null;
  }
  return parseHashlinePaths(source.patch);
}

export function hasDisallowedShellSyntax(command: string): boolean {
  return disallowedShellSyntax.test(command);
}

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (hasDisallowedShellSyntax(trimmed)) {
    return false;
  }
  return readOnlyBashPatterns.some((pattern) => pattern.test(trimmed));
}

export function assessToolCall(toolName: string, input: unknown): ToolAssessment {
  if (readOnlyTools.has(toolName)) {
    return {
      kind: "read-only",
      reason: "allowlisted-read-only-tool",
      explicitMutationPaths: [],
    };
  }

  if (toolName === "bash") {
    const command = commandFromInput(input);
    if (isReadOnlyBashCommand(command)) {
      return {
        kind: "read-only",
        reason: "allowlisted-read-only-bash",
        explicitMutationPaths: [],
      };
    }

    return {
      kind: "mutating",
      reason: "bash-command-not-allowlisted",
      explicitMutationPaths: null,
    };
  }

  if (toolName === "write") {
    return {
      kind: "mutating",
      reason: "write-mutates-files",
      explicitMutationPaths: inputPath(input),
    };
  }

  if (toolName === "edit") {
    return {
      kind: "mutating",
      reason: "edit-mutates-files",
      explicitMutationPaths: inputPath(input),
    };
  }

  if (toolName === "hashline") {
    return {
      kind: "mutating",
      reason: "hashline-mutates-files",
      explicitMutationPaths: hashlinePathsFromInput(input),
    };
  }

  if (explicitMutatingTools.has(toolName)) {
    return {
      kind: "mutating",
      reason: "explicit-mutating-tool",
      explicitMutationPaths: null,
    };
  }

  return {
    kind: "unknown",
    reason: "tool-not-allowlisted-read-only",
    explicitMutationPaths: null,
  };
}

export function isMutatingToolCall(toolName: string, input: unknown): boolean {
  const assessment = assessToolCall(toolName, input);
  return assessment.kind !== "read-only";
}

export function shouldBlockForAck(ackRequired: boolean, toolName: string, input: unknown): boolean {
  if (!ackRequired) {
    return false;
  }
  const assessment = assessToolCall(toolName, input);
  return assessment.kind !== "read-only";
}
