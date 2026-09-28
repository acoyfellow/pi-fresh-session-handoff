import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_CHECKPOINT_TTL_MINUTES,
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_MANIFEST_RELATIVE_PATH,
  DEFAULT_MAX_COMMAND_HISTORY,
  DEFAULT_MAX_LAUNCH_RECORDS,
  ROOT_RELATIVE_PATH,
} from "./constants.js";
import type { FreshSessionConfig, ThresholdConfig, ThresholdNotificationConfig } from "./types.js";
import { clampPositiveInteger } from "./utils.js";

const defaultThresholds: ThresholdConfig = {
  warningPercent: 70,
  preparePercent: 82,
  forcePercent: 92,
  warningTokens: 180000,
  prepareTokens: 210000,
  forceTokens: 240000,
};

const defaultThresholdNotifications: ThresholdNotificationConfig = {
  enabled: true,
  suppressInNonTestBuilderProcess: false,
};

const truthyValues = new Set(["1", "true", "yes", "on"]);
const falsyValues = new Set(["0", "false", "no", "off"]);

export function defaultConfig(cwd: string): FreshSessionConfig {
  return {
    thresholds: { ...defaultThresholds },
    thresholdNotifications: { ...defaultThresholdNotifications },
    checkpointTtlMinutes: DEFAULT_CHECKPOINT_TTL_MINUTES,
    leaseTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
    stateLimits: {
      maxCommandHistory: DEFAULT_MAX_COMMAND_HISTORY,
      maxLaunchRecords: DEFAULT_MAX_LAUNCH_RECORDS,
    },
    manifestPath: path.join(cwd, DEFAULT_MANIFEST_RELATIVE_PATH),
  };
}

function mergeThresholds(base: ThresholdConfig, override: Partial<ThresholdConfig> | undefined): ThresholdConfig {
  if (!override) {
    return base;
  }
  return {
    warningPercent: typeof override.warningPercent === "number" ? override.warningPercent : base.warningPercent,
    preparePercent: typeof override.preparePercent === "number" ? override.preparePercent : base.preparePercent,
    forcePercent: typeof override.forcePercent === "number" ? override.forcePercent : base.forcePercent,
    warningTokens: typeof override.warningTokens === "number" ? override.warningTokens : base.warningTokens,
    prepareTokens: typeof override.prepareTokens === "number" ? override.prepareTokens : base.prepareTokens,
    forceTokens: typeof override.forceTokens === "number" ? override.forceTokens : base.forceTokens,
  };
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (truthyValues.has(normalized)) {
    return true;
  }
  if (falsyValues.has(normalized)) {
    return false;
  }

  return undefined;
}

function mergeThresholdNotifications(
  base: ThresholdNotificationConfig,
  override: Partial<ThresholdNotificationConfig> | undefined,
): ThresholdNotificationConfig {
  if (!override) {
    return base;
  }

  const enabled = parseBoolean(override.enabled);
  const suppressInBuilder = parseBoolean(override.suppressInNonTestBuilderProcess);

  return {
    enabled: enabled ?? base.enabled,
    suppressInNonTestBuilderProcess: suppressInBuilder ?? base.suppressInNonTestBuilderProcess,
  };
}

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBoolean(name: string): boolean | undefined {
  return parseBoolean(process.env[name]);
}

export async function loadConfig(cwd: string): Promise<FreshSessionConfig> {
  const base = defaultConfig(cwd);
  const configPath = path.join(cwd, ROOT_RELATIVE_PATH, "config.json");
  let raw: unknown = undefined;

  try {
    await access(configPath);
    const content = await readFile(configPath, "utf8");
    raw = JSON.parse(content);
  } catch {
    raw = undefined;
  }

  const parsed = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const thresholds = mergeThresholds(
    base.thresholds,
    typeof parsed.thresholds === "object" && parsed.thresholds !== null
      ? (parsed.thresholds as Partial<ThresholdConfig>)
      : undefined,
  );

  const thresholdNotifications = mergeThresholdNotifications(
    base.thresholdNotifications,
    typeof parsed.thresholdNotifications === "object" && parsed.thresholdNotifications !== null
      ? (parsed.thresholdNotifications as Partial<ThresholdNotificationConfig>)
      : undefined,
  );

  const config: FreshSessionConfig = {
    thresholds,
    thresholdNotifications,
    checkpointTtlMinutes:
      typeof parsed.checkpointTtlMinutes === "number"
        ? clampPositiveInteger(parsed.checkpointTtlMinutes, base.checkpointTtlMinutes)
        : base.checkpointTtlMinutes,
    leaseTtlSeconds:
      typeof parsed.leaseTtlSeconds === "number"
        ? clampPositiveInteger(parsed.leaseTtlSeconds, base.leaseTtlSeconds)
        : base.leaseTtlSeconds,
    stateLimits: {
      maxCommandHistory:
        typeof parsed.stateLimits === "object" && parsed.stateLimits !== null
          ? clampPositiveInteger(
              Number((parsed.stateLimits as Record<string, unknown>).maxCommandHistory),
              base.stateLimits.maxCommandHistory,
            )
          : base.stateLimits.maxCommandHistory,
      maxLaunchRecords:
        typeof parsed.stateLimits === "object" && parsed.stateLimits !== null
          ? clampPositiveInteger(
              Number((parsed.stateLimits as Record<string, unknown>).maxLaunchRecords),
              base.stateLimits.maxLaunchRecords,
            )
          : base.stateLimits.maxLaunchRecords,
    },
    manifestPath:
      typeof parsed.manifestPath === "string" && parsed.manifestPath.trim().length > 0
        ? path.resolve(cwd, parsed.manifestPath)
        : base.manifestPath,
  };

  const warningPercent = envNumber("FSH_WARNING_PERCENT");
  const preparePercent = envNumber("FSH_PREPARE_PERCENT");
  const forcePercent = envNumber("FSH_FORCE_PERCENT");
  const warningTokens = envNumber("FSH_WARNING_TOKENS");
  const prepareTokens = envNumber("FSH_PREPARE_TOKENS");
  const forceTokens = envNumber("FSH_FORCE_TOKENS");

  config.thresholds = {
    warningPercent: warningPercent ?? config.thresholds.warningPercent,
    preparePercent: preparePercent ?? config.thresholds.preparePercent,
    forcePercent: forcePercent ?? config.thresholds.forcePercent,
    warningTokens: warningTokens ?? config.thresholds.warningTokens,
    prepareTokens: prepareTokens ?? config.thresholds.prepareTokens,
    forceTokens: forceTokens ?? config.thresholds.forceTokens,
  };

  const thresholdNotificationsEnabled = envBoolean("FSH_THRESHOLD_NOTIFICATIONS_ENABLED");
  const disableBuilderThresholdNotifications = envBoolean("FSH_DISABLE_THRESHOLD_NOTIFICATIONS_FOR_BUILDERS");

  config.thresholdNotifications = {
    enabled: thresholdNotificationsEnabled ?? config.thresholdNotifications.enabled,
    suppressInNonTestBuilderProcess:
      disableBuilderThresholdNotifications ?? config.thresholdNotifications.suppressInNonTestBuilderProcess,
  };

  const ttlMinutes = envNumber("FSH_CHECKPOINT_TTL_MINUTES");
  const leaseTtlSeconds = envNumber("FSH_LEASE_TTL_SECONDS");
  if (ttlMinutes !== undefined) {
    config.checkpointTtlMinutes = clampPositiveInteger(ttlMinutes, config.checkpointTtlMinutes);
  }
  if (leaseTtlSeconds !== undefined) {
    config.leaseTtlSeconds = clampPositiveInteger(leaseTtlSeconds, config.leaseTtlSeconds);
  }

  return config;
}
