import { beforeAll, describe, expect, it } from "vitest";

import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../../src/domain/schema/public";
import {
  decodeCustomClipboardText,
  encodeRuntimeSelection,
} from "../../../../src/persistence/clipboard/codec";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { createSnapshot } from "./fixtures";

function maximumPressureStroke(spacing: number, extreme: boolean): StrokeElementV1 {
  const origin =
    spacing > 1000 ? { x: 0, y: 0 } : extreme ? { x: -990_000, y: 990_000 } : { x: 1000, y: 100 };
  const points = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => {
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
  describe.each([
    ["dense overlapping zigzag", 2, false],
    ["wide zigzag", 900, false],
    ["maximum subdivision and large coordinate digits", 900, true],
    ["maximum subdivision across coordinate range", 900_000.123, true],
  ] as const)("%s", (_name, spacing, extreme) => {
    let stroke: StrokeElementV1;
    let svg: string;

    beforeAll(() => {
      stroke = maximumPressureStroke(spacing, extreme);
      const serialized = serializeInkbookDocument(createSnapshot([stroke]));
      if (!serialized.ok) throw new Error(JSON.stringify(serialized.error));
      svg = serialized.value.svg;
    }, 20_000);

    it("serializes one filled path within SVG capacity limits", () => {
      expect(svg.length).toBeLessThan(48 * 1024 * 1024);
      const content = svg.split('<g id="inkbook-content">')[1]!;
      const paths = [...content.matchAll(/<path d="([^"]+)"([^>]*)\/>/gu)];
      expect(paths).toHaveLength(1);
      const [, pathData, attributes] = paths[0]!;
      expect(attributes).toContain('class="inkbook-theme-fill"');
      expect(attributes).not.toContain("stroke=");
      expect(pathData!.length).toBeLessThan(16 * 1024 * 1024);
      expect(pathData!.match(/[MLQCAZmlqcaz]/g)!.length).toBeLessThanOrEqual(400_000);
    });

    it("round-trips every maximum-capacity sample", async () => {
      const parsed = await parseInkbookDocumentForTest(svg);
      expect(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error)).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.snapshot.elements[0]).toEqual(stroke);
    }, 20_000);
  });
});

describe("maximum stroke clipboard capacity", () => {
  it.each([false, true])("retains every point with pressure enabled: %s", (pressureEnabled) => {
    const stroke = maximumPressureStroke(2, false);
    stroke.style.pressureEnabled = pressureEnabled;
    const encoded = encodeRuntimeSelection([stroke], new Set([stroke.id]));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeCustomClipboardText(encoded.value.customText);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.payload.elements).toHaveLength(1);
    expect(decoded.value.payload.elements[0]!.element).toMatchObject({
      points: stroke.points,
      style: stroke.style,
    });
  });
});
