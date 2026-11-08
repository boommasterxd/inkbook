import { afterEach, expect, it, vi } from "vitest";
import {
  ExportGeometryCache,
  EXPORT_GEOMETRY_CACHE_LIMITS,
} from "../../../../../src/obsidian/embeds/export/export-geometry-cache";
import { ExportGeometrySession } from "../../../../../src/obsidian/embeds/export/export-geometry-session";
import { inspectPreviewSvg } from "../../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { prepareStaticExportFragments } from "../../../../../src/persistence/export/static-export-fragments";
import { prepareExportCutsSteps } from "../../../../../src/domain/export/export-pagination";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import * as bounds from "../../../../../src/domain/geometry/bounds";
import { createCapacityExportSvg } from "../../../../fixtures/persistence/export-geometry";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";
import { exportDescriptor } from "../../../../fixtures/obsidian/markdown-export";

afterEach(() => vi.restoreAllMocks());

it("reuses ten-thousand-stroke geometry across export sessions without worker requests or bound builds", async () => {
  const svg = createCapacityExportSvg();
  const scheduler = createTestWorkScheduler();
  const descriptor = await inspectPreviewSvg(svg, { workScheduler: scheduler });
  if (descriptor === null) throw new Error("Expected validated capacity geometry.");
  const cache = new ExportGeometryCache();
  const boundBuilds = vi.spyOn(bounds, "calculateElementBoundsSteps");
  const execute = vi.spyOn(DocumentWorkerRuntime.prototype, "execute");
  const prepare = vi.fn(async () => {
    const session = new ExportGeometrySession(null, scheduler, new AbortController().signal);
    try {
      return {
        cuts: await session.prepare(descriptor.safeSvg, descriptor.safeStaticProof),
        fragments: await prepareStaticExportFragments(descriptor.safeSvg, {
          workScheduler: scheduler,
        }),
      };
    } finally {
      session.dispose();
    }
  });
  const signal = new AbortController().signal;
  const cold = await cache.prepare(descriptor, prepare, signal);
  expect(cold.cuts?.instrumentation.eventCount).toBe(20_000);
  expect(cold.fragments).toHaveLength(10_001);
  expect(cold.fragments?.filter((fragment) => fragment.background)).toHaveLength(1);
  expect(boundBuilds).toHaveBeenCalledTimes(10_000);
  expect(execute).toHaveBeenCalledOnce();
  const warm = await cache.prepare({ ...descriptor }, prepare, signal);
  expect(warm.cuts).toBe(cold.cuts);
  expect(warm.fragments).toBe(cold.fragments);
  expect(prepare).toHaveBeenCalledOnce();
  expect(boundBuilds).toHaveBeenCalledTimes(10_000);
  expect(execute).toHaveBeenCalledOnce();
  expect(cache.instrumentation.numericBytes).toBeLessThanOrEqual(
    EXPORT_GEOMETRY_CACHE_LIMITS.numericBytes,
  );
  cache.dispose();
  expect(cache.instrumentation).toEqual({ entries: 0, numericBytes: 0 });
});

it("bounds retained numeric slots including fragment bounds before the entry limit is reached", async () => {
  const cache = new ExportGeometryCache();
  const signal = new AbortController().signal;
  const prepare = vi.fn(async () => {
    const intervals = Array.from({ length: 20_000 }, (_, index) => ({
      minY: index * 10,
      maxY: index * 10 + 5,
    }));
    return {
      cuts: finishGeometrySteps(prepareExportCutsSteps(intervals)),
      fragments: intervals.map((interval) => ({ ...interval, background: false })),
    };
  });
  const descriptor = exportDescriptor();
  const capacityBytes = (3 * 40_000 + 2 * 65_536 + 4 + 3 * 20_000) * 8;
  for (let revision = 0; revision < 5; revision += 1) {
    await cache.prepare(
      { ...descriptor, contentIdentity: { ...descriptor.contentIdentity, revision } },
      prepare,
      signal,
    );
    expect(cache.instrumentation.numericBytes).toBeLessThanOrEqual(
      EXPORT_GEOMETRY_CACHE_LIMITS.numericBytes,
    );
  }
  expect(cache.instrumentation).toEqual({ entries: 3, numericBytes: 3 * capacityBytes });
  prepare.mockClear();
  await cache.prepare(
    { ...descriptor, contentIdentity: { ...descriptor.contentIdentity, revision: 4 } },
    prepare,
    signal,
  );
  expect(prepare).not.toHaveBeenCalled();
  await cache.prepare(
    { ...descriptor, contentIdentity: { ...descriptor.contentIdentity, revision: 0 } },
    prepare,
    signal,
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(cache.instrumentation.numericBytes).toBe(3 * capacityBytes);
  cache.dispose();
  expect(cache.instrumentation).toEqual({ entries: 0, numericBytes: 0 });
});
