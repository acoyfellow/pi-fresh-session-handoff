import { spawn as spawnProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const requiredModel = Object.freeze({
  provider: process.env.FSH_BENCHMARK_PROVIDER ?? "example-provider",
  id: process.env.FSH_BENCHMARK_MODEL ?? "example-model",
  route: process.env.FSH_BENCHMARK_ROUTE ?? "example-route",
});

export const defaultBenchmarkTools = Object.freeze(["read", "edit", "write", "ls"]);

const defaultCommandTimeoutMs = 120000;
const defaultIdleTimeoutMs = 120000;
const defaultIdlePollMs = 250;
const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToolList(tools) {
  if (tools === null || tools === undefined) {
    return null;
  }

  if (Array.isArray(tools)) {
    const normalized = tools.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized.join(",") : null;
  }

  const trimmed = String(tools).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(command, response) {
  const fallback = JSON.stringify(response);
  const errorText = isObject(response) && typeof response.error === "string" ? response.error : fallback;
  return new Error(`${command} failed: ${errorText}`);
}

export function buildPiRpcArgs(options = {}) {
  const args = ["--mode", "rpc"];

  if (options.approve !== false) {
    args.push("--approve");
  }

  const provider = options.provider ?? requiredModel.provider;
  const modelId = options.modelId ?? requiredModel.id;
  if (provider) {
    args.push("--provider", provider);
  }
  if (modelId) {
    args.push("--model", modelId);
  }

  const toolList = normalizeToolList(options.tools);
  if (toolList) {
    args.push("--tools", toolList);
  }

  if (options.noExtensions !== false) {
    args.push("--no-extensions");
  }
  if (options.extensionPath) {
    args.push("--extension", options.extensionPath);
  }
  if (options.noSkills !== false) {
    args.push("--no-skills");
  }
  if (options.noPromptTemplates !== false) {
    args.push("--no-prompt-templates");
  }
  if (options.noThemes === true) {
    args.push("--no-themes");
  }
  if (options.noContextFiles !== false) {
    args.push("--no-context-files");
  }

  if (options.persistSession === false) {
    args.push("--no-session");
  } else if (options.sessionDir) {
    args.push("--session-dir", options.sessionDir);
  }

  if (options.session) {
    args.push("--session", options.session);
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (Array.isArray(options.extraArgs) && options.extraArgs.length > 0) {
    args.push(...options.extraArgs.map((entry) => String(entry)));
  }

  return args;
}

export function attachJsonlReader(stream, onRecord) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const handleText = (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) {
        continue;
      }
      onRecord(JSON.parse(line));
    }
  };

  const onData = (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    handleText(text);
  };

  const onEnd = () => {
    const tail = decoder.end();
    if (tail.length > 0) {
      handleText(tail);
    }
    if (buffer.trim().length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      onRecord(JSON.parse(line));
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

export class PiRpcClient {
  static spawn(options = {}) {
    const args = buildPiRpcArgs(options);
    const command = options.command ?? process.env.PI_BENCHMARK_PI_COMMAND ?? "pi";
    const child = (options.spawnImpl ?? spawnProcess)(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: "1",
        FSH_BUILDER_PROCESS: "1",
        FSH_EXTENSION_DISABLED: "0",
        FSH_DISABLE_THRESHOLD_NOTIFICATIONS_FOR_BUILDERS: "1",
        ...options.env,
      },
    });

    return new PiRpcClient(child, options);
  }

  constructor(child, options = {}) {
    this.child = child;
    this.records = [];
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? defaultCommandTimeoutMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

    let settled = false;
    this.exitPromise = new Promise((resolve) => {
      const finalize = () => {
        if (settled) {
          return;
        }
        settled = true;
        for (const [id, pending] of this.pending.entries()) {
          this.clearTimeoutFn(pending.timer);
          pending.reject(new Error(`pi rpc process exited before response ${id}`));
        }
        this.pending.clear();
        resolve();
      };

      child.on("exit", finalize);
      child.on("close", finalize);
      child.on("error", finalize);
    });

    attachJsonlReader(child.stdout, (record) => {
      this.records.push(record);
      this.handleRecord(record);
    });

    child.stderr.on("data", (chunk) => {
      this.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
  }

  handleRecord(record) {
    if (isObject(record) && record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        this.clearTimeoutFn(pending.timer);
        pending.resolve(record);
      }
    }

    if (
      isObject(record) &&
      record.type === "extension_ui_request" &&
      typeof record.id === "string" &&
      typeof record.method === "string" &&
      dialogMethods.has(record.method)
    ) {
      void this.writeRecord({
        type: "extension_ui_response",
        id: record.id,
        cancelled: true,
      }).catch(() => undefined);
    }
  }

  writeRecord(record) {
    if (!this.child.stdin || typeof this.child.stdin.write !== "function") {
      return Promise.reject(new Error("pi rpc stdin is unavailable"));
    }

    const line = `${JSON.stringify(record)}\n`;
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async send(command, options = {}) {
    const commandId = typeof command.id === "string" && command.id.trim().length > 0 ? command.id.trim() : `req-${this.nextId++}`;
    const payload = { ...command, id: commandId };
    const timeoutMs = options.timeoutMs ?? this.defaultCommandTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        this.pending.delete(commandId);
        reject(new Error(`rpc timeout for ${payload.type ?? "command"} (${commandId})`));
      }, timeoutMs);

      this.pending.set(commandId, {
        resolve,
        reject,
        timer,
      });

      this.writeRecord(payload).catch((error) => {
        this.clearTimeoutFn(timer);
        this.pending.delete(commandId);
        reject(error);
      });
    });
  }

  async waitForIdle(options = {}) {
    const timeoutMs = options.timeoutMs ?? defaultIdleTimeoutMs;
    const pollMs = options.pollMs ?? defaultIdlePollMs;
    const deadline = this.now() + timeoutMs;

    while (this.now() <= deadline) {
      const state = await this.getState();
      const streaming = state?.isStreaming === true;
      const compacting = state?.isCompacting === true;
      const pendingMessageCount = Number(state?.pendingMessageCount ?? 0);
      if (!streaming && !compacting && pendingMessageCount === 0) {
        return state;
      }
      if (pollMs > 0) {
        await sleep(pollMs);
      }
    }

    throw new Error(`waitForIdle timeout after ${timeoutMs}ms`);
  }

  async commandAndWait(command, options = {}) {
    const recordIndex = this.records.length;
    const startedAt = this.now();
    const response = await this.send(command, { timeoutMs: options.timeoutMs });
    const state = await this.waitForIdle({
      timeoutMs: options.idleTimeoutMs ?? options.timeoutMs ?? defaultIdleTimeoutMs,
      pollMs: options.pollMs,
    });

    return {
      response,
      state,
      durationMs: this.now() - startedAt,
      records: this.records.slice(recordIndex),
    };
  }

  async promptAndWait(message, options = {}) {
    return this.commandAndWait(
      {
        type: "prompt",
        message,
        streamingBehavior: options.streamingBehavior,
      },
      options,
    );
  }

  async getState(options = {}) {
    const response = await this.send({ type: "get_state" }, options);
    if (!response.success) {
      throw responseError("get_state", response);
    }
    return response.data ?? null;
  }

  async getSessionStats(options = {}) {
    const response = await this.send({ type: "get_session_stats" }, options);
    if (!response.success) {
      throw responseError("get_session_stats", response);
    }
    return response.data ?? null;
  }

  async getLastAssistantText(options = {}) {
    const response = await this.send({ type: "get_last_assistant_text" }, options);
    if (!response.success) {
      throw responseError("get_last_assistant_text", response);
    }
    return response.data?.text ?? null;
  }

  async getAvailableModels(options = {}) {
    const response = await this.send({ type: "get_available_models" }, options);
    if (!response.success) {
      throw responseError("get_available_models", response);
    }
    return Array.isArray(response.data?.models) ? response.data.models : [];
  }

  async setAutoCompaction(enabled, options = {}) {
    const response = await this.send({ type: "set_auto_compaction", enabled: Boolean(enabled) }, options);
    if (!response.success) {
      throw responseError("set_auto_compaction", response);
    }
    return response.data ?? null;
  }

  async compactAndWait(customInstructions, options = {}) {
    return this.commandAndWait(
      {
        type: "compact",
        ...(typeof customInstructions === "string" && customInstructions.trim().length > 0
          ? { customInstructions: customInstructions.trim() }
          : {}),
      },
      options,
    );
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.child.stdin && typeof this.child.stdin.end === "function") {
      this.child.stdin.end();
    }
    await this.exitPromise;
  }
}

export function createBenchmarkRpcClient(options = {}) {
  return PiRpcClient.spawn({
    provider: requiredModel.provider,
    modelId: requiredModel.id,
    approve: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    tools: defaultBenchmarkTools,
    ...options,
  });
}

export function notificationMessages(records) {
  return records
    .filter(
      (record) =>
        isObject(record) &&
        record.type === "extension_ui_request" &&
        record.method === "notify" &&
        typeof record.message === "string",
    )
    .map((record) => ({
      level: typeof record.notifyType === "string" ? record.notifyType : "info",
      message: record.message.trim(),
    }))
    .filter((record) => record.message.length > 0);
}

export function findNotificationMessage(records, pattern) {
  return notificationMessages(records).find((record) => pattern.test(record.message)) ?? null;
}
