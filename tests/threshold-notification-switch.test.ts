import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultConfig, loadConfig } from "../src/core/config.js";
import { shouldDisableExtensionBehavior, shouldEmitThresholdNotifications } from "../src/core/thresholds.js";
import { createTempDir } from "./helpers.js";

async function withEnvironment(
  overrides: Record<string, string | undefined>,
  callback: () => Promise<void> | void,
): Promise<void> {
  const original = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    original.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("threshold notification switch", () => {
  it("defaults to enabled notifications", async () => {
    const cwd = await createTempDir("threshold-notify-default-");
    const config = defaultConfig(cwd);
    expect(config.thresholdNotifications.enabled).toBe(true);
    expect(config.thresholdNotifications.suppressInNonTestBuilderProcess).toBe(false);
  });

  it("loads threshold notification switch from config file", async () => {
    const cwd = await createTempDir("threshold-notify-config-");
    const configPath = path.join(cwd, ".pi", "fresh-session-handoff", "config.json");

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          thresholdNotifications: {
            enabled: true,
            suppressInNonTestBuilderProcess: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const config = await loadConfig(cwd);
    expect(config.thresholdNotifications.enabled).toBe(true);
    expect(config.thresholdNotifications.suppressInNonTestBuilderProcess).toBe(true);
  });

  it("suppresses notifications in non-test builder process when switch is enabled", async () => {
    await withEnvironment(
      {
        FSH_BUILDER_PROCESS: "1",
        NODE_ENV: "production",
        VITEST: undefined,
      },
      async () => {
        const enabled = shouldEmitThresholdNotifications({
          enabled: true,
          suppressInNonTestBuilderProcess: true,
        });
        expect(enabled).toBe(false);
      },
    );
  });

  it("keeps notifications enabled in builder test process", async () => {
    await withEnvironment(
      {
        FSH_BUILDER_PROCESS: "1",
        NODE_ENV: "test",
      },
      async () => {
        const enabled = shouldEmitThresholdNotifications({
          enabled: true,
          suppressInNonTestBuilderProcess: true,
        });
        expect(enabled).toBe(true);
      },
    );
  });

  it("allows env override to disable threshold notifications globally", async () => {
    const cwd = await createTempDir("threshold-notify-env-");

    await withEnvironment(
      {
        FSH_THRESHOLD_NOTIFICATIONS_ENABLED: "0",
      },
      async () => {
        const config = await loadConfig(cwd);
        expect(config.thresholdNotifications.enabled).toBe(false);
      },
    );
  });

  it("keeps extension behavior enabled by default", async () => {
    await withEnvironment(
      {
        FSH_EXTENSION_DISABLED: undefined,
        FSH_BUILDER_PROCESS: undefined,
        PI_BUILDER_PROCESS: undefined,
      },
      async () => {
        expect(shouldDisableExtensionBehavior()).toBe(false);
      },
    );
  });

  it("disables extension behavior only for builder processes when explicitly requested", async () => {
    await withEnvironment(
      {
        FSH_EXTENSION_DISABLED: "1",
        FSH_BUILDER_PROCESS: "1",
      },
      async () => {
        expect(shouldDisableExtensionBehavior()).toBe(true);
      },
    );

    await withEnvironment(
      {
        FSH_EXTENSION_DISABLED: "1",
        FSH_BUILDER_PROCESS: undefined,
        PI_BUILDER_PROCESS: undefined,
      },
      async () => {
        expect(shouldDisableExtensionBehavior()).toBe(false);
      },
    );
  });
});
