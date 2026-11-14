import { describe, expect, it } from "vitest";
import {
  createInitialRecord,
  createReplacementRecord,
} from "../../../../../src/domain/store/records/record-factory";
import { estimateInitialStoreBytes } from "../../../../../src/domain/store/records/active-document-memory-estimate";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import { textElement } from "../../schema/fixtures";

describe("record-owned text paint geometry", () => {
  it("retains the local index across translation and rotation without changing document geometry", () => {
    const initial = createInitialRecord(textElement());
    const text = initial.element as TextElementV2;
    const moved = createReplacementRecord(
      { ...text, x: text.x + 30, pivot: { x: text.pivot.x + 30, y: text.pivot.y } },
      initial,
      1,
      0,
    );
    const rotated = createReplacementRecord(
      { ...(moved.element as TextElementV2), rotation: 35 },
      moved,
      2,
      0,
    );
    expect(initial.textPaintGeometry?.regions).toHaveLength(1);
    expect(moved.textPaintGeometry).toBe(initial.textPaintGeometry);
    expect(rotated.textPaintGeometry).toBe(initial.textPaintGeometry);
    expect(moved.bounds.minX).toBe(initial.bounds.minX + 30);
    expect(rotated.bounds).not.toEqual(moved.bounds);
  });

  it("replaces paint geometry when visibility or prepared layout changes", () => {
    const initial = createInitialRecord(textElement());
    const text = initial.element as TextElementV2;
    const hidden = createReplacementRecord(
      { ...text, style: { ...text.style, opacity: 0 } },
      initial,
      0,
      1,
    );
    expect(hidden.textPaintGeometry).not.toBe(initial.textPaintGeometry);
    expect(hidden.textPaintGeometry?.regions).toHaveLength(0);
    const changed = createReplacementRecord(
      { ...text, layout: { ...text.layout, lines: [] } },
      initial,
      1,
      1,
    );
    expect(changed.textPaintGeometry).not.toBe(initial.textPaintGeometry);
    expect(changed.textPaintGeometry?.regions).toHaveLength(0);
    expect(initial.textPaintGeometry?.regions).toHaveLength(1);
  });

  it("reuses visible paint regions when only their nonzero opacity or color changes", () => {
    const initial = createInitialRecord(textElement());
    const text = initial.element as TextElementV2;
    const painted = createReplacementRecord(
      {
        ...text,
        style: { ...text.style, opacity: 0.5, color: { type: "rgba", value: "#ff0000ff" } },
      },
      initial,
      0,
      1,
    );
    expect(painted.textPaintGeometry).toBe(initial.textPaintGeometry);
    expect(painted.textPaintGeometry?.regions).toHaveLength(1);
    const transparent = createReplacementRecord(
      {
        ...text,
        style: { ...text.style, color: { type: "rgba", value: "#ff000000" } },
      },
      painted,
      0,
      2,
    );
    expect(transparent.textPaintGeometry).not.toBe(painted.textPaintGeometry);
    expect(transparent.textPaintGeometry?.regions).toHaveLength(0);
  });

  it("includes its owned region and tree buffers in active-document memory accounting", () => {
    const record = createInitialRecord(textElement());
    const { textPaintGeometry, ...withoutGeometry } = record;
    expect(textPaintGeometry).toBeDefined();
    expect(estimateInitialStoreBytes([record]) - estimateInitialStoreBytes([withoutGeometry])).toBe(
      textPaintGeometry!.memoryUsage(),
    );
  });
});
