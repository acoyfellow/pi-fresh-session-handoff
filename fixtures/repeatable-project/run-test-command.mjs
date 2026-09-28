import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const createScript = path.join(__dirname, "create-fixture.mjs");

const create = spawnSync("node", [createScript], {
  cwd: path.resolve(__dirname, "..", ".."),
  encoding: "utf8",
  stdio: "pipe",
});

if (create.status !== 0) {
  console.error(create.stderr || create.stdout);
  process.exitCode = create.status ?? 1;
  process.exit();
}

const projectDir = create.stdout.trim().split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1);
if (!projectDir) {
  console.error("fixture path missing");
  process.exit(1);
}

const testRun = spawnSync("npm", ["test"], {
  cwd: projectDir,
  encoding: "utf8",
  stdio: "pipe",
});

if (testRun.status !== 0) {
  console.error(testRun.stdout);
  console.error(testRun.stderr);
  process.exitCode = testRun.status ?? 1;
  process.exit();
}

process.stdout.write(testRun.stdout);
