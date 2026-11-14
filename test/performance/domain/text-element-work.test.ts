import { describe, expect, it } from "vitest";
import { copyRuntimeElementSteps } from "../../../src/domain/elements/runtime-element-copy";
import { scaledTextContentSteps } from "../../../src/domain/geometry/text-scale";
import { calculateElementBounds } from "../../../src/domain/geometry/bounds";
import { textElementPayloadBytes } from "../../../src/domain/schema/text-payload-size";
import { takeImmutableElementOwnership } from "../../../src/domain/store/records/immutability";
import { DocumentCapacity } from "../../../src/domain/store/records/document-capacity";
import { elementContainsPoint } from "../../../src/editor/selection/query/hit-test";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { textElement } from "../../unit/domain/schema/fixtures";
import { textBackgroundGeometrySteps } from "../../../src/domain/geometry/text-backgrounds";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";
import { expandLegacyTextPaddingSteps } from "../../../src/domain/geometry/text-padding";
import { textTableGridPathSteps } from "../../../src/domain/geometry/text-table-grid-path";
import { prepareTextPaintGeometrySteps } from "../../../src/domain/geometry/text-paint-geometry";
import { textRecordGeometrySteps } from "../../../src/domain/store/records/text-record-geometry";
import { MAX_TEXT_LAYOUT_ITEMS } from "../../../src/domain/schema/text-validation-primitives";

function largeText(lineCount = 2000) {
  const text = textElement();
  text.source = "a\n".repeat(lineCount);
  text.height = lineCount * 20;
  text.pivot.y = text.y + text.height / 2;
  text.layout.lines = Array.from({ length: lineCount }, (_, index) => ({
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

  it("cancels scaling before reading the remaining layout and keeps bounds independent of layout", () => {
    const { text, lines } = largeText();
    const scale = scaledTextContentSteps(text, 2);
    expect(scale.next().done).toBe(false);
    expect(lines.work.indexedReads).toBe(1);
    scale.return(undefined as never);
    expect(lines.work.indexedReads).toBe(1);
    expect(calculateElementBounds(text)).toEqual({ minX: 100, minY: 100, maxX: 200, maxY: 40_100 });
    expect(lines.work.indexedReads).toBe(1);
  });
});

describe("bounded text paint work", () => {
  // Each line and its run consume one layout item; 8,192 lines exhaust the shared limit.
  it.each([2000, MAX_TEXT_LAYOUT_ITEMS / 2])(
    "prepares %i paint regions once and prunes warm point queries through the real tree",
    (lineCount) => {
      const { text, lines } = largeText(lineCount);
      let preparationVisits = 0;
      const geometry = finishGeometrySteps(
        prepareTextPaintGeometrySteps(text, () => {
          preparationVisits += 1;
        }),
      );
      expect(lines.work.indexedReads).toBe(lineCount);
      expect(geometry.regions).toHaveLength(lineCount);
      // Every region has one visit per merge pass, plus bounded line/leaf/internal-node work.
      expect(preparationVisits).toBeLessThanOrEqual(
        lineCount * (Math.ceil(Math.log2(lineCount)) + 5),
      );
      expect(geometry.memoryUsage()).toBeLessThanOrEqual(lineCount * 256);
      let nodeVisits = 0;
      let hits = 0;
      const queryY = (lineCount - 5) * 20 + 5;
      geometry.query(
        { minX: 2, minY: queryY, maxX: 3, maxY: queryY + 1 },
        () => {
          hits += 1;
          return true;
        },
        () => {
          nodeVisits += 1;
        },
      );
      expect(hits).toBe(1);
      expect(nodeVisits).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(lineCount)) + 1);
      const point = { x: text.x + 5, y: text.y + queryY };
      expect(elementContainsPoint(text, point, 0, undefined, geometry)).toBe(true);
      expect(elementContainsPoint(text, { ...point, x: text.x + 50 }, 0, undefined, geometry)).toBe(
        false,
      );
      expect(lines.work.indexedReads).toBe(lineCount);
    },
  );

  it("abandons paint preparation after its first run and reuses local paint on movement", () => {
    const { text, lines } = largeText();
    const cancelled = prepareTextPaintGeometrySteps(text);
    expect(cancelled.next().done).toBe(false);
    cancelled.return(undefined as never);
    expect(lines.work.indexedReads).toBe(1);
    const retained = takeImmutableElementOwnership(text);
    const prepared = finishGeometrySteps(textRecordGeometrySteps(retained));
    const record = {
      element: retained,
      bounds: calculateElementBounds(text),
      geometryVersion: 0,
      paintVersion: 0,
      ...prepared,
    };
    const before = lines.work.indexedReads;
    const moved = finishGeometrySteps(
      textRecordGeometrySteps({ ...retained, rotation: 23 }, record),
    );
    expect(moved.textPaintGeometry).toBe(prepared.textPaintGeometry);
    expect(lines.work.indexedReads).toBe(before);
  });
});
