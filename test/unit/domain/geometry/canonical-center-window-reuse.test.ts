import { describe, expect, it, vi } from "vitest";
import { CanonicalElementPathPreparation } from "../../../../src/domain/geometry/canonical-element-path-preparation";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../../src/domain/geometry/stroke-position";
import type { PreparedPressureGeometryPort } from "../../../../src/domain/geometry/pressure/prepared-pressure-geometry";
import { ElementStore } from "../../../../src/domain/store/public";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { selectionStrokeCenterWindow } from "../../../../src/editor/selection/query/stroke-selection-centers";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/content/progressive-preview-path";
import { indexedStroke } from "../../../fixtures/editor/stroke";

function source(count: number, pressureEnabled: boolean, rotation: number, positioned: boolean) {
  const base = indexedStroke(1);
  const offset = { x: -100.003, y: 200.007 };
  return {
    ...base,
    rotation,
    ...(positioned ? { offset } : {}),
    style: { ...base.style, pressureEnabled },
    points: Array.from({ length: count }, (_, index) => [
      (200 + index) / 10,
      30 + (index % 2) * 5,
      (1 + (index % 9)) / 10,
    ]).flat(),
  };
}

function finish(job: CanonicalElementPathPreparation) {
  while (!job.step()) {
    /* Complete bounded canonical windows. */
  }
  return job.parts;
}

describe("canonical local center window reuse", () => {
  const cases = [1, 2, 64, 65, 66, 127, 129].flatMap((count) =>
    [false, true].flatMap((pressureEnabled) =>
      [0, 37].flatMap((rotation) =>
        [false, true].map((positioned) => ({ count, pressureEnabled, rotation, positioned })),
      ),
    ),
  );
  it.each(cases)(
    "preserves exact cold, warm and mixed paths (samples=$count, pressure=$pressureEnabled, rotation=$rotation, positioned=$positioned)",
    ({ count, pressureEnabled, rotation, positioned }) => {
      const store = new ElementStore([source(count, pressureEnabled, rotation, positioned)]);
      const record = store.get(indexedStroke(1).id)!;
      const stroke = record.element as StrokeElementV1;
      const local = strokeLocalGeometry(stroke);
      const prepared = store.pressureGeometry(stroke.id, record.geometryVersion);
      const centers = prepared.local!();
      const expected = buildElementPathParts(local);
      expect(finish(new CanonicalElementPathPreparation(stroke))).toEqual(expected);
      expect(finish(new CanonicalElementPathPreparation(stroke, undefined, "path-only"))).toEqual(
        expected,
      );
      for (let start = 0; start < count; start += 64) {
        selectionStrokeCenterWindow(local, start / 64, centers);
        if (start + 64 >= count - 1) break;
      }
      for (const mixed of [false, true]) {
        const port: PreparedPressureGeometryPort = {
          ...centers,
          readCenters: (index) =>
            mixed && index % 2 === 0 ? undefined : centers.readCenters!(index),
        };
        const world = positioned ? { ...prepared, local: () => port } : port;
        expect(finish(new ProgressivePreviewPath(stroke, world))).toEqual(expected);
      }
      store.releasePreparedPressureGeometry();
    },
  );

  it.each([
    { name: "empty", points: [] },
    { name: "incomplete", points: [0, 0] },
    { name: "oversized", points: Array.from({ length: 16_385 * 3 }, () => 0) },
  ])("preserves sample-count validation for an external $name stroke", ({ points }) => {
    const job = new CanonicalElementPathPreparation({ ...indexedStroke(1), points });
    expect(job.memoryUsage()).toBe(0);
    expect(() => job.step()).toThrow("Stroke samples must contain 1 through 16384 triples.");
    job.cancel();
    expect(job.memoryUsage()).toBe(0);
  });

  it.each([0, 63, 64, 65, 128])(
    "validates non-finite external sample %s despite an offered center cache",
    (index) => {
      const stroke = source(129, true, 37, false);
      stroke.points[index * 3] = NaN;
      const readCenters = vi.fn(() => [{ x: 0, y: 0, pressure: 0.5 }]);
      const job = new CanonicalElementPathPreparation(stroke, {
        readCenters,
        readWindow: () => undefined,
        publishWindow: () => undefined,
      });
      expect(() => finish(job)).toThrow("Stroke samples must be finite.");
      expect(readCenters).not.toHaveBeenCalled();
      job.cancel();
      expect(job.memoryUsage()).toBe(0);
    },
  );
});
