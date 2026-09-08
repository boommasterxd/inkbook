import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import type {
  MemoryCheckpoint,
  MemoryResult,
  ReleasedInstrumentation,
} from "./memory-lifecycle-contract";

const MIB = 1024 * 1024;
const DESKTOP_MEMORY_LIMIT = 1024 * MIB;
const MOBILE_MEMORY_LIMIT = 300 * MIB;
const MAXIMUM_CACHE_ELEMENTS = 20_000;
const MAXIMUM_CACHE_BYTES = 64 * MIB;
const MAXIMUM_RELEASED_HEAP = 8 * MIB;
const MAXIMUM_RETAINED_GROWTH = 1 * MIB;
const RUNNER = fileURLToPath(new URL("./memory-lifecycle-runner.ts", import.meta.url));

describe("persistence memory bounds", () => {
  it("bounds the production main-plus-worker save lifecycle and releases its state", async ({
    annotate,
  }) => {
    const result = await runIsolatedMemoryLifecycle();
    expect(result.lifecycleRuns).toBeGreaterThanOrEqual(5);
    expect(result.coalescedCommitsPerRun).toBeGreaterThanOrEqual(5);
    expect(result.peakBytes).toBeLessThanOrEqual(DESKTOP_MEMORY_LIMIT);
    expect(result.peakBytes).toBeLessThanOrEqual(MOBILE_MEMORY_LIMIT);
    expect(result.cacheElements).toBeLessThanOrEqual(MAXIMUM_CACHE_ELEMENTS);
    expect(result.cacheBytes).toBeLessThanOrEqual(MAXIMUM_CACHE_BYTES);
    expectReleasedState(result.releasedInstrumentation);
    expectRetainedHeap(result.retainedBytes);
    expectRequiredPhases(result.checkpoints);
    await annotate(
      `isolated production lifecycle: peak=${result.peakBytes} bytes (${formatMiB(result.peakBytes)} MiB), ` +
        `output=${result.outputBytes} bytes, retained=${result.retainedBytes.map(formatMiB).join("/")} MiB, ` +
        `runs=${result.lifecycleRuns}, coalescedCommitsPerRun=${result.coalescedCommitsPerRun}, ` +
        "measurement=process.memoryUsage().heapUsed+arrayBuffers after explicit GC",
      "performance",
    );
  }, 180_000);
});

async function runIsolatedMemoryLifecycle(): Promise<MemoryResult> {
  const bundled = await build({
    bundle: true,
    entryPoints: [RUNNER],
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
  });
  const source = bundled.outputFiles[0]?.text;
  if (source === undefined) throw new Error("Memory lifecycle runner was not bundled.");
  const directory = await mkdtemp(join(tmpdir(), "inkbook-memory-lifecycle-"));
  const output = join(directory, "result.json");
  const runner = join(directory, "runner.mjs");
  try {
    await writeFile(runner, source, "utf8");
    const outputFile = await open(output, "w");
    try {
      await executeIsolatedNode(runner, outputFile.fd);
    } finally {
      await outputFile.close();
    }
    return parseResult(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function executeIsolatedNode(runner: string, outputDescriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", "--max-old-space-size=384", runner], {
      stdio: ["ignore", outputDescriptor, "pipe"],
    });
    let stderr = "";
    const stderrStream = child.stderr;
    if (stderrStream === null) {
      reject(new Error("Memory lifecycle runner has no stderr stream."));
      return;
    }
    stderrStream.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Memory lifecycle runner failed (${code ?? "signal"}): ${stderr}`));
    });
  });
}

function parseResult(output: string): MemoryResult {
  const lines = output.trim().split("\n");
  const line = lines[lines.length - 1];
  if (line === undefined) throw new Error("Memory lifecycle runner returned no result.");
  return JSON.parse(line) as MemoryResult;
}

function expectReleasedState(values: readonly ReleasedInstrumentation[]): void {
  expect(values).toHaveLength(5);
  for (const value of values) {
    expect(value).toMatchObject({
      cacheBytes: 0,
      cacheElements: 0,
      prewarmedBytes: 0,
      prewarmedElements: 0,
      retainedCompleteOutputBytes: 0,
      unacknowledgedExports: 0,
    });
  }
}

function expectRetainedHeap(values: readonly number[]): void {
  expect(values).toHaveLength(5);
  expect(Math.max(...values)).toBeLessThanOrEqual(MAXIMUM_RELEASED_HEAP);
  const first = values[0];
  if (first === undefined) throw new Error("Missing retained-heap baseline.");
  expect(Math.max(...values.slice(1))).toBeLessThanOrEqual(first + MAXIMUM_RETAINED_GROWTH);
}

function expectRequiredPhases(checkpoints: readonly MemoryCheckpoint[]): void {
  const phases = new Set(checkpoints.map(({ phase }) => phase));
  for (const phase of [
    "full-export",
    "full-output-released-prewarmed",
    "full-adoption-bytes-plus-string",
    "full-vault-process-current-plus-next",
    "five-commit-coalesced-target",
    "incremental-export",
    "incremental-output-released-prewarmed",
    "worker-slice-transient-peak",
    "incremental-adoption-bytes-plus-string",
    "conflict-recovery-retention",
  ]) {
    expect(phases.has(phase)).toBe(true);
  }
}

function formatMiB(bytes: number): string {
  return (bytes / MIB).toFixed(2);
}
