import { describe, expect, it } from "vitest";
import {
  boundsIntersect,
  buildElementPathParts,
  calculateElementBounds,
} from "../../../../src/domain/geometry/public";
import { scaleElement } from "../../../../src/editor/selection/transforms";
import { selectionPreviewBounds } from "../../../../src/obsidian/embeds/active-editor/selection-preview-bounds";
import { previewPaintPadding } from "../../../../src/rendering/scene/element-presentation";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import {
  mountedPreviewIds,
  ViewportPreviewSelection,
} from "../../../../src/rendering/scene/preview-transform-selection";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import { rectangle } from "../../domain/store/fixtures";
import { FakeDocument } from "./fakes";

describe("mounted preview selection", () => {
  it.each([255, 256, 257, 300])(
    "retains every selected mounted element at capacity %i",
    (count) => {
      const ids = Array.from({ length: count }, (_, index) => String(index));
      const selection = new ViewportPreviewSelection();
      expect(selection.select(ids, [...ids, "unselected"])).toEqual(ids);
      expect(selection.includes("unselected")).toBe(false);
      selection.clear();
      expect(selection.memoryUsage()).toBe(0);
      expect(selection.includes(ids[0]!)).toBe(false);
    },
  );

  it("keeps small offscreen selections without reading scene membership", () => {
    const selection = new ViewportPreviewSelection();
    const mounted = {
      [Symbol.iterator](): Iterator<string> {
        throw new Error("Unexpected mounted traversal");
      },
    };
    const ids = ["offscreen"];
    expect(selection.select(ids, mounted)).toBe(ids);
  });

  it("waits for mounted content in large selections and replaces membership on the next gesture", () => {
    const ids = Array.from({ length: 300 }, (_, index) => String(index));
    const selection = new ViewportPreviewSelection();
    expect(selection.select(ids, [])).toEqual([]);
    expect(selection.select(ids, ["0", "299", "unselected"])).toEqual(["0", "299"]);
    expect(selection.select(["next"], ids)).toEqual(["next"]);
    expect(selection.includes("0")).toBe(false);
    selection.clear();
  });

  it.each(["pressure", "outline"])(
    "retains restored %s paint at a shrink/translation camera boundary",
    (kind) => {
      const source = indexedStroke(0);
      const element =
        kind === "pressure"
          ? {
              ...source,
              points: [20, 20, 1, 22, 22, 1],
              style: { ...source.style, width: 4 as const, pressureEnabled: true },
            }
          : { ...rectangle(), x: 20, y: 20, height: 2, width: 2, pivot: { x: 21, y: 21 } };
      const transformBounds = selectionPreviewBounds({
        kind: "scale",
        anchor: { x: 0, y: 0 },
        factors: { x: 0.1, y: 0.1 },
        delta: { x: 0, y: 500 },
        rotation: 0,
      });
      const record = createSceneRecord(element);
      const mounted = createMountedElement(
        new FakeDocument() as unknown as Document,
        record,
        buildElementPathParts(element),
        createInstrumentation(),
      );
      const affine = transformBounds(record.bounds);
      const boundary = affine.maxY + previewPaintPadding(element) / 2;
      const envelope = { minX: 0, maxX: 100, minY: boundary, maxY: boundary + 100 };
      const canonical = scaleElement(element, { x: 0, y: 0 }, { x: 0.1, y: 0.1 });
      const canonicalBounds = calculateElementBounds(canonical);
      canonicalBounds.minY += 500;
      canonicalBounds.maxY += 500;
      expect(boundsIntersect(affine, envelope)).toBe(false);
      expect(boundsIntersect(canonicalBounds, envelope)).toBe(true);
      expect([
        ...mountedPreviewIds(
          new Map([[element.id, mounted]]),
          { contains: () => false },
          { envelope, transformBounds },
        ),
      ]).toEqual([element.id]);
      expect([
        ...mountedPreviewIds(
          new Map([[element.id, mounted]]),
          { contains: () => false },
          { envelope: { ...envelope, minY: 1000, maxY: 1100 }, transformBounds },
        ),
      ]).toEqual([]);
    },
  );
});
