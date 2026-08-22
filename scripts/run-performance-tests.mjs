import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const performanceRoot = join(projectRoot, "test", "performance");
const vitestEntry = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const testFiles = await collectTestFiles(performanceRoot);
if (testFiles.length === 0) throw new Error("No performance test files were found.");

for (const testFile of testFiles) {
  await runTestFile(testFile);
}

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
}

function runTestFile(testFile) {
  const relativeTestFile = relative(projectRoot, testFile);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        vitestEntry,
        "run",
        relativeTestFile,
        "--reporter=verbose",
        "--fileParallelism=false",
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${relativeTestFile} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}
