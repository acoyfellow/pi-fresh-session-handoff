import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const sourceRoot = process.cwd();
const sourceDir = path.join(sourceRoot, "src");
const targetDir = process.env.FSH_INSTALL_DIR ?? path.join(homedir(), ".pi", "agent", "extensions", "fresh-session-handoff");
const targetIndexPath = path.join(targetDir, "index.ts");
const targetPackagePath = path.join(targetDir, "package.json");
const targetSourceDir = path.join(targetDir, "src");

const packageJson = {
  name: "fresh-session-handoff",
  private: true,
  type: "module",
  pi: {
    extensions: ["./index.ts"],
  },
};

const indexSource = "export { default } from \"./src/extension.ts\";\n";

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetSourceDir, { recursive: true, force: true });
await writeFile(targetIndexPath, indexSource, "utf8");
await writeFile(targetPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

console.log(`installed extension at ${targetDir}`);
