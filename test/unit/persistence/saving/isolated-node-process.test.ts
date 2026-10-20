import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { executeIsolatedNode } from "../../../fixtures/persistence/isolated-node-process";

async function processFixture(source: string, timeoutMs = 10_000) {
  const directory = await mkdtemp(join(tmpdir(), "inkbook-process-lifecycle-"));
  const path = join(directory, "output");
  const output = await open(path, "w");
  const controller = new AbortController();
  const completion = executeIsolatedNode({
    args: ["--eval", source],
    outputDescriptor: output.fd,
    signal: controller.signal,
    timeoutMs,
  });
  // Failure is asserted by each caller; attach immediately while waiting for child readiness.
  void completion.catch(() => undefined);
  onTestFinished(async () => {
    controller.abort();
    try {
      await completion.catch(() => undefined);
    } finally {
      await output.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
  return { completion, controller, path };
}

it("reaps an aborted running process before rejecting and releasing its output", async () => {
  const child = await processFixture(
    "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);",
  );
  const pid = await vi.waitFor(async () => {
    const value = Number(await readFile(child.path, "utf8"));
    expect(value).toBeGreaterThan(0);
    return value;
  });
  child.controller.abort();
  await expect(child.completion).rejects.toThrow("aborted");
  expect(() => process.kill(pid, 0)).toThrow();
});

it("terminates a stalled process when its execution deadline expires", async () => {
  const child = await processFixture("setInterval(() => {}, 1000);", 100);
  await expect(child.completion).rejects.toThrow("execution timeout");
});

it("terminates a process that exceeds the stderr bound", async () => {
  const child = await processFixture(
    "process.stderr.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000);",
  );
  await expect(child.completion).rejects.toThrow("stderr exceeded 64 KiB");
});

it("propagates process failure diagnostics and accepts a successful exit", async () => {
  const failed = await processFixture(
    "process.stderr.write('export failed'); process.exitCode = 1;",
  );
  await expect(failed.completion).rejects.toThrow("failed (1): export failed");
  const succeeded = await processFixture("process.stdout.write('complete');");
  await expect(succeeded.completion).resolves.toBeUndefined();
  expect(await readFile(succeeded.path, "utf8")).toBe("complete");
});
