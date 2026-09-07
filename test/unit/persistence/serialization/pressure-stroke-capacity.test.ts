import { describe, expect, it } from "vitest";

import { buildStrokePath } from "../../../../src/domain/geometry/stroke-path";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { createSnapshot } from "./fixtures";

function maximumPressureStroke(spacing: number, extreme: boolean): StrokeElementV1 {
  const origin = extreme ? { x: -990_000, y: 990_000 } : { x: 1000, y: 100 };
  const points = Array.from({ length: 4096 }, (_, index) => {
    const x = extreme ? [-spacing, spacing, 0][index % 3]! : [0, spacing, 0, -spacing][index % 4]!;
    const y = extreme ? [-spacing, 0, spacing, 0][index % 4]! : index * 0.1;
    return [origin.x + x, Math.round((origin.y + y) * 1000) / 1000, (index % 3) / 2];
  }).flat();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: 0,
    kind: "stroke",
    tool: "pen",
    rotation: 0,
    pivot: origin,
    points,
    style: {
      color: { type: "theme-text" },
      opacity: 0.5,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 22,
    },
  };
}

describe("maximum pressure stroke persistence", () => {
  it.each([
    ["dense overlapping zigzag", 2, false],
    ["wide zigzag", 900, false],
    ["maximum subdivision and large coordinate digits", 900, true],
  ] as const)("round-trips all 4096 samples for %s", async (_name, spacing, extreme) => {
    const stroke = maximumPressureStroke(spacing, extreme);
    const geometry = buildStrokePath(stroke);
    const commands = geometry.d.match(/[MLAZ]/g)!.length;
    expect(commands).toBeGreaterThan(20_000);
    if (extreme) expect(commands).toBeGreaterThan(170_000);
    expect(commands).toBeLessThanOrEqual(200_000);
    expect(geometry.d.length).toBeLessThan(8 * 1024 * 1024);

    const serialized = serializeInkbookDocument(createSnapshot([stroke]));
    expect(serialized.ok, JSON.stringify(serialized.ok ? null : serialized.error)).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.svg.length).toBeLessThan(48 * 1024 * 1024);
    const parsed = await parseInkbookDocumentForTest(serialized.value.svg);
    expect(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.snapshot.elements[0]).toEqual(stroke);
  });
});
