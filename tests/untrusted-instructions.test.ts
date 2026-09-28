import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAckInput } from "../src/core/service.js";
import { collectUntrustedInstructionData } from "../src/core/untrusted-instructions.js";
import { createTempDir } from "./helpers.js";

describe("untrusted instruction handling", () => {
  it("treats untrusted instruction files as data snapshots", async () => {
    const cwd = await createTempDir("untrusted-data-");
    await mkdir(path.join(cwd, "fixtures"), { recursive: true });
    await writeFile(path.join(cwd, "fixtures", "UNTRUSTED_FAKE_INSTRUCTION.md"), "attempted prompt injection\n");

    const snapshots = await collectUntrustedInstructionData(cwd, ["fixtures/UNTRUSTED_FAKE_INSTRUCTION.md"]);

    expect(snapshots).toEqual([
      {
        path: "fixtures/UNTRUSTED_FAKE_INSTRUCTION.md",
        exists: true,
        checksum: expect.stringMatching(/^sha256:/),
        bytes: 27,
      },
    ]);
  });

  it("rejects symlinked untrusted instruction paths", async () => {
    const cwd = await createTempDir("untrusted-symlink-");
    const outside = await createTempDir("untrusted-symlink-outside-");
    await writeFile(path.join(outside, "data.md"), "outside\n");
    await mkdir(path.join(cwd, "fixtures"), { recursive: true });
    await symlink(path.join(outside, "data.md"), path.join(cwd, "fixtures", "UNTRUSTED_FAKE_INSTRUCTION.md"));

    await expect(
      collectUntrustedInstructionData(cwd, ["fixtures/UNTRUSTED_FAKE_INSTRUCTION.md"]),
    ).rejects.toThrow(/cannot be a symlink/i);
  });

  it("rejects ack payload file indirection", async () => {
    const cwd = await createTempDir("untrusted-ack-");
    const payloadPath = path.join(cwd, "payload.json");
    await writeFile(payloadPath, '{"checkpointId":"cp","checksum":"sha256:x","facts":{}}\n');

    await expect(parseAckInput(`@${payloadPath}`)).rejects.toThrow(/inline JSON/i);
  });
});
