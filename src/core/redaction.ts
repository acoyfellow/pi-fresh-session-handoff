import type { RedactionReport } from "./types.js";
import { sortUnique } from "./utils.js";

const secretLikePattern = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION|BEARER|SASL|JWT|SSH|PGPASSWORD)/i;

const safeExactKeys = new Set([
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "LANG",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "TZ",
]);

const safePrefixes = ["LC_", "PI_", "NODE_"];

export function isSecretLikeEnvKey(key: string): boolean {
  return secretLikePattern.test(key);
}

function canKeepEnvKey(key: string): boolean {
  if (safeExactKeys.has(key)) {
    return true;
  }
  if (safePrefixes.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  return false;
}

export function buildRedactionReport(env: NodeJS.ProcessEnv): RedactionReport {
  const removedEnvKeys: string[] = [];
  const keptEnvKeys: string[] = [];

  for (const key of Object.keys(env)) {
    if (isSecretLikeEnvKey(key)) {
      removedEnvKeys.push(key);
      continue;
    }

    if (canKeepEnvKey(key)) {
      keptEnvKeys.push(key);
      continue;
    }

    removedEnvKeys.push(key);
  }

  return {
    removedEnvKeys: sortUnique(removedEnvKeys),
    keptEnvKeys: sortUnique(keptEnvKeys),
    transcriptStored: false,
    toolOutputsStored: false,
    assistantReasoningStored: false,
  };
}
