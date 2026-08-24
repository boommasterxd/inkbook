import { describe, expect, it } from "vitest";

import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import { rectangle, snapshot } from "./fixtures";

const executor = { sessionId: "phase-test", workerEpoch: 1 } as const;

describe("document worker phase instrumentation", () => {
  it("records separate unlock and export phase durations", async () => {
    const serialized = serializeInkbookDocument(snapshot());
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime(executor);
    await runtime.execute({
      identity: { ...executor, operationId: 1, purpose: "unlock" },
      input: serialized.value.svg,
      type: "unlock",
    });
    expectNonnegativeDurations(runtime.instrumentation.lastUnlockPhases);

    await runtime.execute({
      ...executor,
      baseModelRevision: 0,
      changedElements: [rectangle(180)],
      exportGeneration: 1,
      modelRevision: 1,
      type: "export-incremental",
    });
    expectNonnegativeDurations(runtime.instrumentation.lastExportPhases);
    runtime.terminate();
  });
});

function expectNonnegativeDurations(values: Readonly<object>): void {
  expect(Object.keys(values).length).toBeGreaterThan(0);
  for (const duration of Object.values(values) as unknown[]) {
    expect(typeof duration).toBe("number");
    if (typeof duration !== "number") continue;
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  }
}
