/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact schema boundary values are intentional. */
import { describe, expect, it } from "vitest";

import {
  validateCanonicalGeometryV1,
  validateCanonicalStyleV1,
  validateElementBindingV1,
  validateSceneElementV1,
  validateSceneElementValueV1,
} from "../../../src/domain/model";
import {
  everyElementKind,
  FIXED_BINDING,
  POSITION_BINDING,
  RANGE_BINDING,
} from "../codecs/scene-support";

describe("model record validation", () => {
  it("accepts every element, geometry, style, and binding discriminator", () => {
    const elements = everyElementKind();

    expect(
      elements.map((element) => validateSceneElementV1(element).kind),
    ).toEqual(elements.map(({ kind }) => kind));
    expect(validateElementBindingV1(FIXED_BINDING)).toEqual(FIXED_BINDING);
    expect(validateElementBindingV1(POSITION_BINDING)).toEqual(
      POSITION_BINDING,
    );
    expect(validateElementBindingV1(RANGE_BINDING)).toEqual(RANGE_BINDING);
    for (const element of elements) {
      expect(validateCanonicalStyleV1(element.style, element.kind)).toEqual(
        element.style,
      );
      expect(
        validateCanonicalGeometryV1(element.geometry, element.kind),
      ).toEqual(element.geometry);
    }
  });

  it("accepts canonical decimal values affected by binary floating-point", () => {
    const pen = everyElementKind()[0];
    if (pen?.kind !== "pen") throw new TypeError("Expected the Pen fixture.");

    expect(
      validateCanonicalStyleV1(
        { ...pen.style, smoothing: 0.29, streamline: 0.58 },
        "pen",
      ),
    ).toMatchObject({ smoothing: 0.29, streamline: 0.58 });
    expect(() =>
      validateCanonicalStyleV1({ ...pen.style, smoothing: 0.291 }, "pen"),
    ).toThrow(/0.01/u);
    expect(() =>
      validateCanonicalStyleV1({ ...pen.style, smoothing: -0 }, "pen"),
    ).toThrow(/0.01/u);
  });

  it("accepts frozen input without mutating its records", () => {
    const source = everyElementKind()[2];
    if (source?.kind !== "rectangle") {
      throw new TypeError("Expected the Rectangle fixture.");
    }
    const frozen = Object.freeze({
      ...source,
      geometry: Object.freeze({ ...source.geometry }),
      style: Object.freeze({ ...source.style }),
    });

    expect(validateSceneElementV1(frozen)).toEqual(frozen);
    expect(Object.isFrozen(frozen.geometry)).toBe(true);
  });

  it("validates revision-free values and solid fills", () => {
    const source = everyElementKind()[2];
    if (source?.kind !== "rectangle") {
      throw new TypeError("Expected the Rectangle fixture.");
    }
    const value = {
      elementId: source.elementId,
      kind: source.kind,
      binding: source.binding,
      geometry: source.geometry,
      style: source.style,
    };

    expect(validateSceneElementValueV1(value)).toEqual(value);
    expect(
      validateCanonicalStyleV1(
        {
          ...source.style,
          fill: { kind: "solid", color: "currentColor", opacity: 0.29 },
        },
        "rectangle",
      ),
    ).toMatchObject({ fill: { kind: "solid", opacity: 0.29 } });
  });

  it("rejects unknown fields, non-finite values, and cross-kind records", () => {
    const [pen, , rectangle] = everyElementKind();
    expect(() => validateSceneElementV1({ ...pen, transient: true })).toThrow(
      /closed V1/u,
    );
    if (rectangle?.kind !== "rectangle") {
      throw new TypeError("Expected the Rectangle fixture.");
    }
    expect(() =>
      validateCanonicalGeometryV1(
        { ...rectangle.geometry, width: Number.POSITIVE_INFINITY },
        "rectangle",
      ),
    ).toThrow(RangeError);
    expect(() => validateCanonicalStyleV1(rectangle.style, "line")).toThrow(
      TypeError,
    );
  });
});

describe("model binding boundaries", () => {
  it("enforces binding confidence, span, context, and margin boundaries", () => {
    expect(() =>
      validateElementBindingV1({ ...POSITION_BINDING, confidence: "low" }),
    ).toThrow(/confidence/u);
    expect(() =>
      validateElementBindingV1({
        ...POSITION_BINDING,
        inferenceProfileVersion: 2,
      }),
    ).toThrow(/profile/u);
    const range = RANGE_BINDING;
    if (range.kind !== "text-range" || range.presentation !== "enclosure") {
      throw new TypeError("Expected the Enclosure fixture.");
    }
    expect(
      validateElementBindingV1({
        ...range,
        end: { ...range.end, utf16Offset: 65_538 },
      }),
    ).toMatchObject({ end: { utf16Offset: 65_538 } });
    expect(() =>
      validateElementBindingV1({
        ...range,
        end: { ...range.end, utf16Offset: 65_539 },
      }),
    ).toThrow(/span/u);
    expect(
      validateElementBindingV1({
        ...range,
        start: { ...range.start, contextBefore: "x".repeat(256) },
      }),
    ).toMatchObject({ start: { contextBefore: "x".repeat(256) } });
    expect(() =>
      validateElementBindingV1({
        ...range,
        start: { ...range.start, contextBefore: "x".repeat(257) },
      }),
    ).toThrow(/context/u);
    expect(
      validateElementBindingV1({
        ...range,
        marginsInLineHeights: {
          top: 0,
          right: -1_024,
          bottom: 1_024,
          left: 0,
        },
      }),
    ).toMatchObject({
      marginsInLineHeights: {
        top: 0,
        right: -1_024,
        bottom: 1_024,
        left: 0,
      },
    });
    expect(() =>
      validateElementBindingV1({
        ...range,
        marginsInLineHeights: {
          ...range.marginsInLineHeights,
          top: 1_025,
        },
      }),
    ).toThrow(/margin/u);
    expect(() =>
      validateElementBindingV1({
        ...range,
        marginsInLineHeights: {
          ...range.marginsInLineHeights,
          top: -1_025,
        },
      }),
    ).toThrow(/margin/u);
  });
});

describe("model Table boundaries", () => {
  it.each(["width", "height"] as const)(
    "accepts Table %s 2 and rejects 1.9999",
    (dimension) => {
      const table = everyElementKind()[9];
      if (table?.kind !== "table") {
        throw new TypeError("Expected the Table fixture.");
      }

      expect(
        validateCanonicalGeometryV1(
          { ...table.geometry, [dimension]: 2 },
          "table",
        ),
      ).toMatchObject({ [dimension]: 2 });
      expect(() =>
        validateCanonicalGeometryV1(
          { ...table.geometry, [dimension]: 1.9999 },
          "table",
        ),
      ).toThrow(/range/u);
    },
  );

  it.each(["rowDividerOffsets", "columnDividerOffsets"] as const)(
    "accepts 199 and rejects 200 Table entries for %s",
    (dividerKey) => {
      const table = everyElementKind()[9];
      if (table?.kind !== "table") {
        throw new TypeError("Expected the Table fixture.");
      }
      const dividerOffsets = Array.from(
        { length: 199 },
        (_, index) => -1 + (index + 1) / 100,
      );

      expect(
        validateCanonicalGeometryV1(
          { ...table.geometry, [dividerKey]: dividerOffsets },
          "table",
        ),
      ).toMatchObject({ [dividerKey]: dividerOffsets });
      expect(() =>
        validateCanonicalGeometryV1(
          {
            ...table.geometry,
            [dividerKey]: [...dividerOffsets, 0],
          },
          "table",
        ),
      ).toThrow(/limit/u);
      expect(() =>
        validateCanonicalGeometryV1(
          { ...table.geometry, [dividerKey]: [-0.99, -0.9801] },
          "table",
        ),
      ).toThrow(/separated/u);
    },
  );
});

describe("model axes and geometry boundaries", () => {
  it.each([
    ["axes-2d", 10],
    ["axes-3d", 11],
  ] as const)(
    "accepts grid divisions 0, 1, and 64 and rejects 65 for %s",
    (kind, elementIndex) => {
      const axes = everyElementKind()[elementIndex];
      if (axes?.kind !== kind) {
        throw new TypeError(`Expected the ${kind} fixture.`);
      }
      for (const gridDivisions of [0, 1, 64]) {
        expect(
          validateCanonicalGeometryV1(
            { ...axes.geometry, gridDivisions },
            kind,
          ),
        ).toMatchObject({ gridDivisions });
      }
      expect(() =>
        validateCanonicalGeometryV1(
          { ...axes.geometry, gridDivisions: 65 },
          kind,
        ),
      ).toThrow(/grid divisions/iu);
    },
  );

  it("enforces canonical angles, table tracks, axes, and pressure coupling", () => {
    const elements = everyElementKind();
    const rectangle = elements[2];
    const table = elements[9];
    const axes = elements[10];
    const pen = elements[0];
    if (
      rectangle?.kind !== "rectangle" ||
      table?.kind !== "table" ||
      axes?.kind !== "axes-2d" ||
      pen?.kind !== "pen"
    ) {
      throw new TypeError("Unexpected fixture kinds.");
    }
    expect(() =>
      validateCanonicalGeometryV1(
        { ...rectangle.geometry, rotationRadians: Math.PI },
        "rectangle",
      ),
    ).toThrow(/canonical/u);
    expect(() =>
      validateCanonicalGeometryV1(
        { ...table.geometry, rowDividerOffsets: [0, 0] },
        "table",
      ),
    ).toThrow(/separated/u);
    expect(() =>
      validateCanonicalGeometryV1(
        { ...axes.geometry, yAxis: { x: 2, y: 0 } },
        "axes-2d",
      ),
    ).toThrow(/collinear/u);
    expect(() =>
      validateSceneElementV1({
        ...pen,
        style: { ...pen.style, pressure: "pointer" },
      }),
    ).toThrow(/pressure/u);
    const highlighter = elements[1];
    if (highlighter?.kind !== "highlighter") {
      throw new TypeError("Expected the Highlighter fixture.");
    }
    expect(() =>
      validateSceneElementV1({
        ...highlighter,
        geometry: {
          ...highlighter.geometry,
          stroke: {
            ...highlighter.geometry.stroke,
            pressure: "present",
            data: "AA",
          },
        },
      }),
    ).toThrow(/Highlighter/u);
  });
});
