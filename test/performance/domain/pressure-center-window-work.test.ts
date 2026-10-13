import { expect, it, vi, type MockInstance } from "vitest";
import { CanonicalElementPathPreparation } from "../../../src/domain/geometry/canonical-element-path-preparation";
import * as strokePath from "../../../src/domain/geometry/stroke-path";
import * as simplification from "../../../src/domain/geometry/stroke-simplification";
import { strokeLocalGeometry } from "../../../src/domain/geometry/stroke-position";
import { ElementStore } from "../../../src/domain/store/public";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../src/domain/schema/public";
import { selectionStrokeCenterWindow } from "../../../src/editor/selection/stroke-selection-centers";
import { indexedStroke } from "../../fixtures/editor/stroke";

function fixture() {
  const base = indexedStroke(1);
  const store = new ElementStore([
    {
      ...base,
      points: Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [index / 20, 30, 0.5]).flat(),
    },
  ]);
  const record = store.get(base.id)!;
  const stroke = record.element as StrokeElementV1;
  const local = strokeLocalGeometry(stroke);
  const prepared = store.pressureGeometry(stroke.id, record.geometryVersion).local!();
  const windows = Math.ceil((MAX_STROKE_POINTS - 1) / 64);
  return { store, record, stroke, local, prepared, windows };
}

function warm(test: ReturnType<typeof fixture>): void {
  for (let index = 0; index < test.windows; index += 1)
    selectionStrokeCenterWindow(test.local, index, test.prepared);
}

function finish(job: CanonicalElementPathPreparation): void {
  while (!job.step()) {
    /* Complete bounded preparation. */
  }
}

function expectStopped(job: CanonicalElementPathPreparation, centers: MockInstance): void {
  job.cancel();
  expect(job.memoryUsage()).toBe(0);
  centers.mockClear();
  expect(job.step()).toBe(false);
  expect(centers).not.toHaveBeenCalled();
}

it("reads no maximum-stroke samples or simplification windows on retained center hits", () => {
  const test = fixture();
  warm(test);
  const bytes = test.store.activeDocumentMemoryUsage().selectionGeometryCacheBytes;
  const read = vi.spyOn(strokePath, "strokeCenterAt");
  const simplify = vi.spyOn(simplification, "simplifyStrokeCenters");
  const publish = vi.spyOn(test.prepared, "publishCenters");
  try {
    const job = new CanonicalElementPathPreparation(test.stroke, test.prepared);
    finish(job);
    expect(read).not.toHaveBeenCalled();
    expect(simplify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(test.store.activeDocumentMemoryUsage().selectionGeometryCacheBytes).toBe(bytes);
    job.cancel();
    expect(job.memoryUsage()).toBe(0);
  } finally {
    read.mockRestore();
    simplify.mockRestore();
    publish.mockRestore();
    test.store.releasePreparedPressureGeometry();
  }
});

it("reads only a missing center window and preserves its already prepared seam", () => {
  const test = fixture();
  warm(test);
  const read = vi.spyOn(strokePath, "strokeCenterAt");
  const simplify = vi.spyOn(simplification, "simplifyStrokeCenters");
  const publish = vi.spyOn(test.prepared, "publishCenters");
  try {
    const missing = 128;
    const job = new CanonicalElementPathPreparation(test.stroke, {
      ...test.prepared,
      readCenters: (index) => (index === missing ? undefined : test.prepared.readCenters!(index)),
    });
    finish(job);
    expect(read).toHaveBeenCalledTimes(64);
    expect(read.mock.calls.map(([, index]) => index)).toEqual(
      Array.from({ length: 64 }, (_, index) => missing * 64 + index + 1),
    );
    expect(simplify).toHaveBeenCalledOnce();
    expect(simplify.mock.calls[0]![0]).toHaveLength(65);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    simplify.mockRestore();
    publish.mockRestore();
    test.store.releasePreparedPressureGeometry();
  }
});

it("keeps cold center preparation within one window without retaining a raw prefix", () => {
  const test = fixture();
  const read = vi.spyOn(strokePath, "strokeCenterAt");
  const publish = vi.spyOn(test.prepared, "publishCenters");
  try {
    const job = new CanonicalElementPathPreparation(test.stroke, test.prepared);
    for (let index = 0; index < test.windows; index += 1) {
      read.mockClear();
      expect(job.step()).toBe(false);
      expect(read.mock.calls.length).toBe(index === 0 ? 65 : index === test.windows - 1 ? 63 : 64);
      // A straight constant-pressure window retains its two endpoints only.
      if (index < test.windows - 1) expect(job.memoryUsage()).toBe((index + 2) * 32);
    }
    expect(publish).not.toHaveBeenCalled();
    expectStopped(job, read);
  } finally {
    read.mockRestore();
    publish.mockRestore();
    test.store.releasePreparedPressureGeometry();
  }
});

it.each(["memory-pressure", "stale", "released"] as const)(
  "uses bounded cold centers after %s revokes prepared ownership",
  (reason) => {
    const test = fixture();
    warm(test);
    if (reason === "memory-pressure") test.store.setActiveDocumentMemoryPressure(true);
    else if (reason === "released") test.store.releasePreparedPressureGeometry();
    else test.store.replace(test.stroke.id, { ...test.stroke, rotation: 37 });
    const read = vi.spyOn(strokePath, "strokeCenterAt");
    try {
      const job = new CanonicalElementPathPreparation(test.stroke, test.prepared);
      expect(job.step()).toBe(false);
      expect(read).toHaveBeenCalledTimes(65);
      expectStopped(job, read);
    } finally {
      read.mockRestore();
      test.store.releasePreparedPressureGeometry();
    }
  },
);
