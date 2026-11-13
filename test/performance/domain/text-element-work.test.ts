import { describe, expect, it } from "vitest";
import { copyRuntimeElementSteps } from "../../../src/domain/elements/runtime-element-copy";
import { scaledTextContentSteps } from "../../../src/domain/geometry/text-scale";
import { calculateElementBounds } from "../../../src/domain/geometry/bounds";
import { textElementPayloadBytes } from "../../../src/domain/schema/text-payload-size";
import { takeImmutableElementOwnership } from "../../../src/domain/store/records/immutability";
import { DocumentCapacity } from "../../../src/domain/store/records/document-capacity";
import { elementContainsPoint } from "../../../src/editor/selection/query/hit-test";
import { visitVisibleElementPrimitives } from "../../../src/editor/selection/query/element-selection-geometry";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { textElement } from "../../unit/domain/schema/fixtures";
import { textBackgroundGeometrySteps } from "../../../src/domain/geometry/text-backgrounds";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";
import { expandLegacyTextPaddingSteps } from "../../../src/domain/geometry/text-padding";
import { textTableGridPathSteps } from "../../../src/domain/geometry/text-table-grid-path";

function largeText() {
  const text = textElement();
  text.source = "a\n".repeat(2000);
  text.height = 40_000;
  text.pivot.y = text.y + text.height / 2;
  text.layout.lines = Array.from({ length: 2000 }, (_, index) => ({
    x: 0,
    y: index * 20,
    width: 10,
    height: 20,
    baseline: 15,
    runs: [{ text: "a", start: index * 2, end: index * 2 + 1, x: 0, width: 10 }],
  }));
  const lines = observeSchemaArray(text.layout.lines);
  text.layout.lines = lines.observed;
  return { text, lines };
}

it("upgrades legacy padding with one retained-line visit and can abandon that preparation", () => {
  const { text, lines } = largeText();
  const upgraded = finishGeometrySteps(expandLegacyTextPaddingSteps(text));
  expect(lines.work.indexedReads).toBe(2000);
  expect(upgraded.layout.lines).toHaveLength(2000);
  const retained = observeSchemaArray(upgraded.layout.lines);
  const padded = { ...upgraded, layout: { ...upgraded.layout, lines: retained.observed } };
  expect(finishGeometrySteps(expandLegacyTextPaddingSteps(padded))).toBe(padded);
  expect(retained.work.indexedReads).toBe(0);
  lines.work.indexedReads = 0;
  const cancelled = expandLegacyTextPaddingSteps(text);
  expect(cancelled.next().done).toBe(false);
  cancelled.return(undefined as never);
  expect(lines.work.indexedReads).toBe(1);
});

it("builds one capacity grid with one read per row and abandons remaining grid work", () => {
  const rows = observeSchemaArray(Array<number>(3000).fill(20));
  const table = {
    start: 0,
    end: 1,
    x: 0,
    y: 0,
    width: 640,
    height: 60_000,
    columns: 32,
    rowHeights: rows.observed,
    borderWidth: 1,
  };
  const path = finishGeometrySteps(textTableGridPathSteps(table));
  expect(rows.work.indexedReads).toBe(2999);
  expect(path.match(/M/gu)).toHaveLength(3034);
  expect(path.length).toBeLessThan(200_000);
  rows.work.indexedReads = 0;
  const cancelled = textTableGridPathSteps({ ...table, columns: 1 });
  expect(cancelled.next().done).toBe(false);
  cancelled.return(undefined as never);
  expect(rows.work.indexedReads).toBe(1);
});
describe("bounded text element work", () => {
  it("partitions two thousand inline backgrounds with bounded real interval visits and abandons cancelled layout work", () => {
    const { text, lines } = largeText();
    for (const line of text.layout.lines) line.runs[0]!.style = { backgroundOpacity: 0.125 };
    lines.work.indexedReads = 0;
    let visits = 0;
    const result = finishGeometrySteps(
      textBackgroundGeometrySteps(text, () => {
        visits += 1;
      }),
    );
    expect(lines.work.indexedReads).toBe(2000);
    // Coverage remains bounded by 32 visits per line. Four edges per strip each
    // contribute two events, with cooperative merge passes and linear stitching.
    const contourVisits = 8 * 2000 * (Math.ceil(Math.log2(2 * 2000)) + 4);
    expect(visits).toBeLessThanOrEqual(32 * 2000 + contourVisits);
    expect(result.basePath?.length).toBeLessThan(200_000);
    expect(result.paints).toHaveLength(0);
    lines.work.indexedReads = 0;
    const cancelled = textBackgroundGeometrySteps(text);
    expect(cancelled.next().done).toBe(false);
    cancelled.return(undefined as never);
    expect(lines.work.indexedReads).toBe(1);
  });
  it("reuses retained layout accounting for translation, paint and removal capacity changes", () => {
    const { text, lines } = largeText();
    const owned = takeImmutableElementOwnership(text);
    if (owned.kind !== "text") throw new Error("Expected a text field.");
    textElementPayloadBytes(owned);
    const before = lines.work.indexedReads;
    const copy = copyRuntimeElementSteps({ ...owned, x: 110 }, undefined, owned);
    let copied = copy.next();
    while (!copied.done) copied = copy.next();
    expect(copied.value.layout).toBe(owned.layout);
    const record = {
      element: owned,
      bounds: calculateElementBounds(text),
      geometryVersion: 0,
      paintVersion: 0,
    };
    const capacity = new DocumentCapacity();
    capacity.addInitial(record);
    const moved = {
      ...record,
      element: { ...owned, x: 110, style: { ...owned.style, opacity: 0.5 } },
    };
    capacity.commit(capacity.prepare([record], [moved]));
    capacity.commit(capacity.prepare([moved], []));
    expect(lines.work.indexedReads).toBe(before);
  });
  it("copies the real 2,000-line layout once with bounded descriptor reads per step", () => {
    const { text, lines } = largeText();
    const copy = copyRuntimeElementSteps(text);
    let result = copy.next();
    let previous = 0;
    while (!result.done) {
      expect(lines.work.descriptorReads - previous).toBeLessThanOrEqual(256);
      previous = lines.work.descriptorReads;
      result = copy.next();
    }
    expect(lines.work.descriptorReads).toBe(2000);
    expect(result.value.layout.lines).toHaveLength(2000);
    expect(result.value.layout.lines).not.toBe(text.layout.lines);
    result.value.layout.lines[0]!.runs[0]!.text = "changed";
    expect(text.layout.lines[0]!.runs[0]!.text).toBe("a");
  });

  it("cancels scaling before reading the remaining layout and never reads layout for box queries", () => {
    const { text, lines } = largeText();
    const scale = scaledTextContentSteps(text, 2);
    expect(scale.next().done).toBe(false);
    expect(lines.work.indexedReads).toBe(1);
    scale.return(undefined as never);
    expect(lines.work.indexedReads).toBe(1);
    expect(calculateElementBounds(text)).toEqual({ minX: 100, minY: 100, maxX: 200, maxY: 40_100 });
    expect(elementContainsPoint(text, { x: 150, y: 30_000 }, 0)).toBe(true);
    let primitives = 0;
    visitVisibleElementPrimitives(text, () => {
      primitives += 1;
      return true;
    });
    expect(primitives).toBe(1);
    expect(lines.work.indexedReads).toBe(1);
  });
});
