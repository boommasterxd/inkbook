import { describe, expect, it } from "vitest";
import { collapsedElements } from "../../../fixtures/domain/collapsed-elements";

import { FILE_SCHEMA_LIMITS, validateInkElementV1 } from "../../../../src/domain/schema/public";
import {
  arrow,
  coordinateSystem,
  line,
  rectangle,
  straightHighlighter,
  stroke,
  table,
} from "./fixtures";

describe("InkElementV1 validation", () => {
  it.each([0, 0.001])("accepts zero and tiny geometry at size %s", (size) => {
    for (const element of collapsedElements(size)) {
      expect(validateInkElementV1(element), element.kind).toMatchObject({ ok: true });
    }
  });
  it.each([
    stroke(),
    stroke(8, "highlighter"),
    straightHighlighter(),
    line(),
    arrow(),
    rectangle(),
    { ...rectangle(15), style: { ...rectangle().style, outlineWidth: 1 as const } },
    { ...rectangle(9), kind: "ellipse" as const },
    { ...rectangle(10), kind: "triangle" as const },
    { ...rectangle(11), kind: "octagon" as const },
    { ...rectangle(12), kind: "parallelogram" as const },
    { ...rectangle(13), kind: "diamond" as const },
    coordinateSystem(),
    {
      ...coordinateSystem(14),
      dimension: "3d" as const,
      axes: [...coordinateSystem().axes, { x: 300, y: 500 }],
    },
    table(),
    { ...table(), columnOffsets: [40, 80] },
    { ...table(), columnOffsets: [0, 0], headerHeight: 0 },
    { ...table(), columnOffsets: [120, 120], headerHeight: 80 },
    { ...table(), columns: 1, columnOffsets: [], pivot: { x: 120, y: 340 } },
  ])("accepts a valid $kind element", (element) => {
    expect(validateInkElementV1(element).ok).toBe(true);
  });

  it("accepts a bent straight highlighter using the shared linear geometry", () => {
    const element = { ...straightHighlighter(), bend: { x: 150, y: 180 } };

    expect(validateInkElementV1(element).ok).toBe(true);
  });

  it("accepts the maximum points per stroke", () => {
    const element = stroke();
    element.points = Array.from({ length: 4096 }, (_, index) => [index, 100, 0.5]).flat();
    expect(validateInkElementV1(element).ok).toBe(true);
  });
});

describe("InkElementV1 invalid input validation", () => {
  it.each([
    ["unknown property", { ...stroke(), extra: true }, "unknown-property"],
    ["unsupported kind", { ...stroke(), kind: "script" }, "invalid-literal"],
    ["uppercase UUID", { ...stroke(), id: "00000000-0000-4000-A000-000000000001" }, "invalid-uuid"],
    ["negative timestamp", { ...stroke(), createdAt: -1 }, "invalid-number"],
    ["unnormalized rotation", { ...stroke(), rotation: 180 }, "invalid-range"],
    ["negative zero", { ...stroke(), rotation: -0 }, "invalid-range"],
    ["noncanonical coordinate", { ...stroke(), pivot: { x: 1.2345, y: 100 } }, "invalid-number"],
    [
      "lowercase RGBA",
      { ...stroke(), style: { ...stroke().style, color: { type: "rgba", value: "#aabbccdd" } } },
      "invalid-color",
    ],
    [
      "highlighter pressure",
      { ...stroke(1, "highlighter"), style: { ...stroke().style, pressureEnabled: true } },
      "invalid-literal",
    ],
    ["nonfinite line", { ...line(), end: { x: Infinity, y: 150 } }, "invalid-number"],
    ["negative shape width", { ...rectangle(), width: -0.001 }, "invalid-range"],
    ["negative shape height", { ...rectangle(), height: -0.001 }, "invalid-range"],
    ["wrong shape pivot", { ...rectangle(), pivot: { x: 151, y: 150 } }, "invalid-range"],
    [
      "coordinate pivot mismatch",
      { ...coordinateSystem(), pivot: { x: 401, y: 400 } },
      "invalid-range",
    ],
    [
      "nonfinite coordinate axis",
      {
        ...coordinateSystem(),
        axes: [
          { x: NaN, y: 400 },
          { x: 400, y: 300 },
        ],
      },
      "invalid-number",
    ],
    ["negative table column width", { ...table(), columnWidth: -0.001 }, "invalid-range"],
    ["negative table height", { ...table(), height: -0.001 }, "invalid-range"],
    ["table header below outer bounds", { ...table(), headerHeight: -0.001 }, "invalid-range"],
    ["table header above outer bounds", { ...table(), headerHeight: 80.001 }, "invalid-range"],
    ["table column offset count", { ...table(), columnOffsets: [40] }, "invalid-range"],
    [
      "table column offset below outer bounds",
      { ...table(), columnOffsets: [-1, 80] },
      "invalid-range",
    ],
    ["table column offset order", { ...table(), columnOffsets: [80, 40] }, "invalid-range"],
    [
      "table column offset above outer bounds",
      { ...table(), columnOffsets: [40, 121] },
      "invalid-range",
    ],
    [
      "table noncanonical column offset",
      { ...table(), columnOffsets: [40.0005, 80] },
      "invalid-number",
    ],
  ])("rejects %s", (_name, element, code) => {
    const result = validateInkElementV1(element);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe("InkElementV1 resource validation", () => {
  it("rejects malformed and excessive stroke arrays", () => {
    expect(validateInkElementV1({ ...stroke(), points: [] }).ok).toBe(false);
    expect(validateInkElementV1({ ...stroke(), points: [1, 2] }).ok).toBe(false);
    const excessive = Array.from({ length: 4097 }, () => [100, 100, 0.5]).flat();
    expect(validateInkElementV1({ ...stroke(), points: excessive }).ok).toBe(false);
  });

  it("rejects an over-wide unknown container before inspecting its values", () => {
    const element = { ...stroke(), extra: new Array(FILE_SCHEMA_LIMITS.elements + 1).fill(null) };
    const result = validateInkElementV1(element);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("json-node-limit-exceeded");
  });

  it("applies injected count limits without weakening field validation", () => {
    const result = validateInkElementV1(stroke(), {
      limits: { ...FILE_SCHEMA_LIMITS, strokePoints: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stroke-point-limit-exceeded");
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const element = stroke() as unknown as Record<string, unknown>;
    Object.defineProperty(element, "createdAt", {
      enumerable: true,
      get() {
        invoked = true;
        return 0;
      },
    });
    expect(validateInkElementV1(element).ok).toBe(false);
    expect(invoked).toBe(false);
  });
});
