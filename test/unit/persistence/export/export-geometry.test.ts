import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareExportGeometry } from "../../../../src/persistence/export/export-geometry";
import { chooseExportCut } from "../../../../src/domain/export/export-pagination";
import { calculateElementBounds } from "../../../../src/domain/geometry/bounds";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  createWorkerSnapshot,
  createTestStroke,
} from "../../../fixtures/persistence/worker-snapshot";
import { createAllElementSnapshot } from "../serialization/fixtures";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";

const identity = {
  sessionId: "export-test",
  workerEpoch: 1,
  operationId: 1,
  purpose: "preflight" as const,
};
let runtime: DocumentWorkerRuntime;
beforeEach(() => {
  runtime = new DocumentWorkerRuntime(identity);
});
afterEach(() => runtime.terminate());

const workScheduler = createTestWorkScheduler();

function serialize(snapshot = createWorkerSnapshot([createTestStroke()])) {
  const result = serializeInkbookDocument(snapshot);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.svg;
}

describe("export geometry preparation", () => {
  it("uses complete model bounds for rotated shapes, arrows and stroke widths", async () => {
    for (const element of createAllElementSnapshot().elements) {
      const cuts = await prepareExportGeometry(serialize(createWorkerSnapshot([element])), {
        runtime,
        identity,
        workScheduler,
      });
      expect(cuts).toBeDefined();
      const bound = calculateElementBounds(element);
      const limit = (bound.minY + bound.maxY) / 2;
      const start = bound.minY - 10;
      const cut = chooseExportCut(cuts!, { start, limit, minimum: 1, lookback: limit - start });
      expect(cut).toBeCloseTo(bound.minY, 8);
    }
  });

  it("excludes backgrounds and reuses an authenticated safe-static proof", async () => {
    const snapshot = createWorkerSnapshot([]);
    snapshot.page.background = { type: "lines", spacing: 25 };
    const svg = serialize(snapshot);
    const trusted = await inspectTrustedSvgOutput(svg, undefined, { workScheduler });
    const cuts = await prepareExportGeometry(svg, {
      runtime,
      identity,
      workScheduler,
      safeStaticProof: trusted.safeStaticProof,
    });
    expect(cuts!.instrumentation.eventCount).toBe(0);
    expect(chooseExportCut(cuts!, { start: 0, limit: 100, minimum: 1, lookback: 90 })).toBe(100);
  });

  it("falls back to continuous static output for invalid editable metadata", async () => {
    const svg = serialize().replace(
      /data-inkbook-snapshot-sha256="[^"]+"/u,
      'data-inkbook-snapshot-sha256="' + "0".repeat(64) + '"',
    );
    expect(await prepareExportGeometry(svg, { workScheduler, runtime, identity })).toBeUndefined();
  });

  it("publishes no partial index when preparation is cancelled", async () => {
    const abort = new AbortController();
    let admitted = 0;
    const scheduler = createTestWorkScheduler({
      checkpoint: () => {
        if (++admitted === 3) abort.abort();
      },
    });
    await expect(
      prepareExportGeometry(serialize(), {
        runtime,
        identity,
        workScheduler: scheduler,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(
      await prepareExportGeometry(serialize(), { workScheduler, runtime, identity }),
    ).toBeDefined();
  });

  it("reports execution failure separately from invalid editable metadata", async () => {
    runtime.terminate();
    await expect(
      prepareExportGeometry(serialize(), { workScheduler, runtime, identity }),
    ).rejects.toThrow();
  });
});
