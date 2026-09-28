import type { ThresholdConfig, ThresholdNotificationConfig, ThresholdStage } from "./types.js";

const stageOrder: Record<ThresholdStage, number> = {
  below: 0,
  warning: 1,
  prepare: 2,
  force: 3,
};

const truthyValues = new Set(["1", "true", "yes", "on"]);

function envFlag(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name];
  if (typeof value !== "string") {
    return false;
  }
  return truthyValues.has(value.trim().toLowerCase());
}

function isBuilderProcess(env: NodeJS.ProcessEnv): boolean {
  return envFlag("FSH_BUILDER_PROCESS", env) || envFlag("PI_BUILDER_PROCESS", env);
}

export function shouldDisableExtensionBehavior(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!envFlag("FSH_EXTENSION_DISABLED", env)) {
    return false;
  }
  return isBuilderProcess(env);
}

function isTestProcess(env: NodeJS.ProcessEnv): boolean {
  if (envFlag("FSH_BUILDER_TEST_PROCESS", env)) {
    return true;
  }
  if (envFlag("VITEST", env)) {
    return true;
  }
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "test";
}

export function evaluateThreshold(
  usage: { tokens: number | null; percent: number | null },
  config: ThresholdConfig,
): ThresholdStage {
  const tokens = usage.tokens ?? -1;
  const percent = usage.percent ?? -1;

  const force = tokens >= config.forceTokens || percent >= config.forcePercent;
  if (force) {
    return "force";
  }

  const prepare = tokens >= config.prepareTokens || percent >= config.preparePercent;
  if (prepare) {
    return "prepare";
  }

  const warning = tokens >= config.warningTokens || percent >= config.warningPercent;
  if (warning) {
    return "warning";
  }

  return "below";
}

export function shouldNotifyThresholdTransition(previous: ThresholdStage | undefined, next: ThresholdStage): boolean {
  if (!previous) {
    return next !== "below";
  }
  return stageOrder[next] > stageOrder[previous];
}

export function shouldEmitThresholdNotifications(
  config: ThresholdNotificationConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!config.enabled) {
    return false;
  }

  if (!config.suppressInNonTestBuilderProcess) {
    return true;
  }

  if (!isBuilderProcess(env)) {
    return true;
  }

  return isTestProcess(env);
}
