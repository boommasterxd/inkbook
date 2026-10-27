import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { createMountedElement } from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { SceneRunStrokeWidth } from "../../../../../src/rendering/scene/presentation/selection-run-width";
import {
  FakeDocument,
  FakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

it("changes only finite container paint for 10,000 prepared paths and restores local state", () => {
  const document = new FakeDocument();
  const svg = new FakeNode(document, "svg") as unknown as SVGSVGElement;
  const group = new FakeNode(document, "g") as unknown as SVGGElement;
  const instrumentation = createInstrumentation();
  let zoom = 2;
  const width = new SceneRunStrokeWidth({
    svg,
    instrumentation,
    zoom: () => zoom,
  });
  for (let index = 0; index < 10_000; index += 1) {
    const record = fakeRectangleRecord(String(index), index, 0);
    const entry = createMountedElement(
      document as never,
      record,
      buildElementPathParts(record.element),
      instrumentation,
    );
    width.prepare(entry);
  }
  const existingPaint = group.style;
  existingPaint.setProperty("--inkbook-run-width-0", "old");
  const attributeReads = vi.spyOn(FakeNode.prototype, "getAttribute");
  const attributeWrites = vi.spyOn(FakeNode.prototype, "setAttribute");
  const attributeRemovals = vi.spyOn(FakeNode.prototype, "removeAttribute");
  const stylePrototype = Object.getPrototypeOf(group.style) as CSSStyleDeclaration;
  const styleReads = vi.spyOn(stylePrototype, "getPropertyValue");
  const styleWrites = vi.spyOn(stylePrototype, "setProperty");
  const before = instrumentation.attributeWrites;
  width.setActive(group, true);
  expect(instrumentation.attributeWrites - before).toBe(2);
  zoom = 0.5;
  width.refreshZoom();
  expect(instrumentation.attributeWrites - before).toBe(3);
  width.setActive(group, false);
  expect(instrumentation.attributeWrites - before).toBe(5);
  expect(attributeReads).toHaveBeenCalledTimes(3);
  expect(styleReads).toHaveBeenCalledTimes(4);
  expect(attributeWrites).toHaveBeenCalledTimes(1);
  expect(attributeRemovals).toHaveBeenCalledTimes(1);
  expect(styleWrites).toHaveBeenCalledTimes(3);
  vi.restoreAllMocks();
  expect(group.style.getPropertyValue("--inkbook-run-width-0")).toBe("old");
  expect(width.memoryUsage()).toMatchObject({
    trackedEntries: 10_000,
    trackedPaths: 10_000,
    paletteOverrides: 0,
  });
  const writes = instrumentation.attributeWrites;
  width.discard();
  expect(instrumentation.attributeWrites).toBe(writes);
  expect(width.memoryUsage()).toEqual({
    trackedEntries: 0,
    trackedPaths: 0,
    widthPaletteEntries: 0,
    dashPaletteEntries: 0,
    paletteOverrides: 0,
  });
});
