import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  PiRpcClient,
  attachJsonlReader,
  buildPiRpcArgs,
  notificationMessages,
} from "../scripts/benchmark-live-rpc.mjs";

class MockPiProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: Array<Record<string, unknown>> = [];
  readonly stdin: Writable;
  private readonly onCommand: (record: Record<string, unknown>, process: MockPiProcess) => void;
  private buffer = "";

  constructor(onCommand: (record: Record<string, unknown>, process: MockPiProcess) => void) {
    super();
    this.onCommand = onCommand;

    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.buffer += chunk.toString("utf8");
        while (true) {
          const newlineIndex = this.buffer.indexOf("\n");
          if (newlineIndex === -1) {
            break;
          }
          const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (!line.trim()) {
            continue;
          }
          const record = JSON.parse(line) as Record<string, unknown>;
          this.commands.push(record);
          this.onCommand(record, this);
        }
        callback();
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => {
          this.emit("exit", 0);
          this.emit("close", 0);
        });
      },
    });
  }

  send(record: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

describe("benchmark live rpc helpers", () => {
  it("builds minimal isolated rpc args for benchmark sessions", () => {
    const args = buildPiRpcArgs({
      sessionDir: "/tmp/sessions",
      extensionPath: "/tmp/extension",
      name: "benchmark-source",
      tools: ["read", "edit", "write", "ls"],
    });

    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
    expect(args).toContain("--provider");
    expect(args).toContain("example-provider");
    expect(args).toContain("--model");
    expect(args).toContain("example-model");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--extension");
    expect(args).toContain("/tmp/extension");
    expect(args).toContain("--session-dir");
    expect(args).toContain("/tmp/sessions");
    expect(args).toContain("--tools");
    expect(args).toContain("read,edit,write,ls");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-prompt-templates");
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--approve");
    expect(args).toContain("--name");
    expect(args).toContain("benchmark-source");
  });

  it("parses rpc jsonl records using LF framing only", async () => {
    const stream = new PassThrough();
    const records: Array<Record<string, unknown>> = [];
    attachJsonlReader(stream, (record: unknown) => records.push(record as Record<string, unknown>));

    const first = JSON.stringify({ type: "message_update", text: `hello
world`.replace("\n", "\u2028") });
    const second = JSON.stringify({ type: "response", id: "req-1", success: true });
    stream.write(`${first}\n${second}\r\n`, "utf8");
    stream.end();

    await new Promise((resolve) => setImmediate(resolve));

    expect(records).toEqual([
      { type: "message_update", text: `hello
world`.replace("\n", "\u2028") },
      { type: "response", id: "req-1", success: true },
    ]);
  });

  it("waits for prompt settlement and preserves notifications", async () => {
    let getStateCalls = 0;
    const mock = new MockPiProcess((record, process) => {
      if (record.type === "prompt") {
        process.send({
          type: "extension_ui_request",
          id: "note-1",
          method: "notify",
          notifyType: "warning",
          message: "Acknowledge checkpoint before editing",
        });
        process.send({ type: "response", id: record.id, command: "prompt", success: true });
        return;
      }

      if (record.type === "get_state") {
        getStateCalls += 1;
        process.send({
          type: "response",
          id: record.id,
          command: "get_state",
          success: true,
          data: {
            isStreaming: getStateCalls === 1,
            isCompacting: false,
            pendingMessageCount: getStateCalls === 1 ? 1 : 0,
            sessionId: "source-session",
            sessionFile: "/tmp/source-session.jsonl",
            model: {
              provider: "example-provider",
              id: "example-model",
            },
          },
        });
      }
    });

    const client = new PiRpcClient(mock, { defaultCommandTimeoutMs: 1000 });
    const result = await client.promptAndWait("hello", { timeoutMs: 1000, pollMs: 0 });

    expect(result.state.sessionId).toBe("source-session");
    expect(getStateCalls).toBe(2);
    expect(notificationMessages(result.records)).toEqual([
      {
        level: "warning",
        message: "Acknowledge checkpoint before editing",
      },
    ]);
    expect(mock.commands.map((record) => record.type)).toEqual(["prompt", "get_state", "get_state"]);

    await client.close();
  });

  it("auto-cancels unexpected extension dialogs", async () => {
    let sawCancelledDialog = false;
    const mock = new MockPiProcess((record, process) => {
      if (record.type === "prompt") {
        process.send({
          type: "extension_ui_request",
          id: "dialog-1",
          method: "confirm",
          title: "Unexpected prompt",
          message: "Should be cancelled automatically",
        });
        process.send({ type: "response", id: record.id, command: "prompt", success: true });
        return;
      }

      if (record.type === "extension_ui_response") {
        sawCancelledDialog = record.id === "dialog-1" && record.cancelled === true;
        return;
      }

      if (record.type === "get_state") {
        process.send({
          type: "response",
          id: record.id,
          command: "get_state",
          success: true,
          data: {
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionId: "source-session",
            sessionFile: "/tmp/source-session.jsonl",
          },
        });
      }
    });

    const client = new PiRpcClient(mock, { defaultCommandTimeoutMs: 1000 });
    await client.promptAndWait("hello", { timeoutMs: 1000, pollMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sawCancelledDialog).toBe(true);

    await client.close();
  });
});
