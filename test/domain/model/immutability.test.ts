/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact canonical model fixtures exercise nested record shapes. */
import { describe, expect, it } from "vitest";

import type {
  Axes3DElementV1,
  ElementBinding,
  EnclosureRangeBinding,
  LineElementV1,
  SceneElementV1,
  TableElementV1,
} from "../../../src/domain/model";
import {
  createBindingRevision,
  createGeometryRevision,
  createSceneRevision,
  createStyleRevision,
  generateElementId,
  generateGroupId,
  materializeElementBinding,
  materializeSceneElementV1,
  parseBlockFingerprintV1,
  parseElementId,
  parseGroupId,
  parseHexRgbaV1,
} from "../../../src/domain/model";
import { elementIdFor, FIXED_BINDING } from "./support";

const RANDOM_BYTE_LENGTH = 16;
const MAX_RANDOM_BYTE = 255;
const EXPECTED_ID_LENGTH = 29;
const EXPECTED_GROUP_ID_LENGTH = 30;
const ANCHOR_OFFSET = 12;

function repeatedByteSource(byte: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(byte);
}

function componentRevisions(): Pick<
  LineElementV1,
  "geometryRevision" | "styleRevision" | "bindingRevision"
> {
  return {
    geometryRevision: createGeometryRevision(1),
    styleRevision: createStyleRevision(1),
    bindingRevision: createBindingRevision(1),
  };
}

function enclosureBinding(): EnclosureRangeBinding {
  const anchor = {
    utf16Offset: ANCHOR_OFFSET,
    association: "after" as const,
    blockKind: "paragraph" as const,
    contextBefore: "before",
    contextAfter: "after",
    blockFingerprint: parseBlockFingerprintV1("a".repeat(64)),
  };
  return {
    kind: "text-range",
    start: anchor,
    end: { ...anchor, utf16Offset: ANCHOR_OFFSET + 1 },
    presentation: "enclosure",
    marginsInLineHeights: { top: 1, right: 1, bottom: 1, left: 1 },
    origin: "manual",
    confidence: "high",
    inferenceProfileVersion: 1,
  };
}

describe("domain scalar constructors", () => {
  it("creates deterministic syntactically valid IDs from an injected byte source", () => {
    const zeroElement = generateElementId(repeatedByteSource(0));
    const maximumElement = generateElementId(
      repeatedByteSource(MAX_RANDOM_BYTE),
    );
    const zeroGroup = generateGroupId(repeatedByteSource(0));

    expect(zeroElement).toBe(`el_${"0".repeat(26)}`);
    expect(maximumElement.startsWith("el_7")).toBe(true);
    expect(zeroElement).toHaveLength(EXPECTED_ID_LENGTH);
    expect(zeroGroup).toHaveLength(EXPECTED_GROUP_ID_LENGTH);
    expect(() => generateElementId(() => new Uint8Array(1))).toThrow(
      RangeError,
    );
    expect(() => parseElementId("el_invalid")).toThrow(TypeError);
    expect(() => parseGroupId("grp_invalid")).toThrow(TypeError);
    expect(() => repeatedByteSource(0)(RANDOM_BYTE_LENGTH)).not.toThrow();
  });

  it("rejects invalid branded scalars before casting", () => {
    expect(() => createSceneRevision(-1)).toThrow(RangeError);
    expect(() => createSceneRevision(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      RangeError,
    );
    expect(() => parseHexRgbaV1("#ABCDEFff")).toThrow(TypeError);
    expect(() => parseBlockFingerprintV1("A".repeat(64))).toThrow(TypeError);
  });
});

describe("deeply immutable domain records", () => {
  it("copies and freezes every nested enclosure binding record", () => {
    const source = enclosureBinding();
    const materialized = materializeElementBinding(source);

    expect(materialized).not.toBe(source);
    expect(Object.isFrozen(materialized)).toBe(true);
    if (materialized.kind !== "text-range") throw new Error("Unexpected kind");
    expect(Object.isFrozen(materialized.start)).toBe(true);
    expect(Object.isFrozen(materialized.end)).toBe(true);
    if (materialized.presentation !== "enclosure") {
      throw new Error("Unexpected presentation");
    }
    expect(Object.isFrozen(materialized.marginsInLineHeights)).toBe(true);
    expect(Reflect.set(materialized.start, "utf16Offset", 0)).toBe(false);
  });

  it("deeply freezes attached linear geometry and style", () => {
    const element: LineElementV1 = {
      ...componentRevisions(),
      elementId: elementIdFor(0),
      binding: FIXED_BINDING,
      kind: "arrow",
      geometry: {
        start: {
          fallbackPoint: { x: 1, y: 2 },
          attachment: {
            targetElementId: elementIdFor(1),
            portId: "area:east",
          },
        },
        end: { fallbackPoint: { x: 3, y: 4 }, attachment: null },
        control: { x: 2, y: 3 },
      },
      style: {
        color: "currentColor",
        opacity: 1,
        width: 1,
        dash: "dashed",
        startCap: "none",
        endCap: "arrow",
        capSize: 4,
      },
    };
    const frozen = materializeSceneElementV1(element);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.binding)).toBe(true);
    expect(Object.isFrozen(frozen.geometry)).toBe(true);
    if (frozen.kind !== "arrow") throw new Error("Unexpected kind");
    expect(Object.isFrozen(frozen.geometry.start)).toBe(true);
    expect(Object.isFrozen(frozen.geometry.start.fallbackPoint)).toBe(true);
    expect(Object.isFrozen(frozen.geometry.start.attachment)).toBe(true);
    expect(Object.isFrozen(frozen.geometry.control)).toBe(true);
    expect(Object.isFrozen(frozen.style)).toBe(true);
  });
});

describe("binding and drawing record variants", () => {
  it("freezes text-position and fragment-range anchor records", () => {
    const anchor = enclosureBinding().start;
    const bindings: ElementBinding[] = [
      {
        kind: "text-position",
        anchor,
        localOffsetX: 2,
        localOffsetY: 3,
        origin: "inferred",
        confidence: "medium",
        inferenceProfileVersion: 1,
      },
      {
        kind: "text-range",
        start: anchor,
        end: { ...anchor, utf16Offset: anchor.utf16Offset + 1 },
        presentation: "underline",
        origin: "inferred",
        confidence: "high",
        inferenceProfileVersion: 1,
      },
    ];

    for (const binding of bindings.map(materializeElementBinding)) {
      expect(Object.isFrozen(binding)).toBe(true);
      if (binding.kind === "text-position") {
        expect(Object.isFrozen(binding.anchor)).toBe(true);
      } else if (binding.kind === "text-range") {
        expect(Object.isFrozen(binding.start)).toBe(true);
        expect(Object.isFrozen(binding.end)).toBe(true);
      }
    }
  });
});

describe("drawing record variants", () => {
  it("freezes Pen, Highlighter, and Shape geometry and styles", () => {
    const revisions = componentRevisions();
    const stroke = {
      stroke: {
        codec: "delta-varint-v1" as const,
        pointCount: 1,
        originXQ: 0,
        originYQ: 0,
        pressure: "absent" as const,
        data: "",
      },
      selectionRotationRadians: 0,
    };
    const paint = {
      color: "currentColor" as const,
      opacity: 1,
      width: 1,
      dash: "solid" as const,
    };
    const elements: SceneElementV1[] = [
      {
        ...revisions,
        elementId: elementIdFor(4),
        binding: FIXED_BINDING,
        kind: "pen",
        geometry: stroke,
        style: {
          ...paint,
          pressure: "constant",
          smoothing: 0,
          streamline: 0,
          thinning: 0,
          strokeProfileVersion: 1,
        },
      },
      {
        ...revisions,
        elementId: elementIdFor(5),
        binding: FIXED_BINDING,
        kind: "highlighter",
        geometry: stroke,
        style: { ...paint, variant: "freehand" },
      },
      {
        ...revisions,
        elementId: elementIdFor(6),
        binding: FIXED_BINDING,
        kind: "ellipse",
        geometry: {
          center: { x: 0, y: 0 },
          width: 2,
          height: 3,
          rotationRadians: 0,
        },
        style: { ...paint, fill: { kind: "none" } },
      },
    ];

    for (const element of elements.map(materializeSceneElementV1)) {
      expect(Object.isFrozen(element.geometry)).toBe(true);
      expect(Object.isFrozen(element.style)).toBe(true);
      if (element.kind === "pen" || element.kind === "highlighter") {
        expect(Object.isFrozen(element.geometry.stroke)).toBe(true);
      } else if (element.kind === "ellipse") {
        expect(Object.isFrozen(element.geometry.center)).toBe(true);
        expect(Object.isFrozen(element.style.fill)).toBe(true);
      }
    }
  });
});

describe("deeply immutable construction records", () => {
  it("freezes construction vectors and table divider sequences", () => {
    const common = {
      ...componentRevisions(),
      binding: enclosureBinding(),
      style: {
        color: "currentColor" as const,
        opacity: 1,
        width: 1,
        dash: "solid" as const,
        positiveEndCap: "arrow" as const,
        capSize: 4,
      },
    };
    const axes: Axes3DElementV1 = {
      ...common,
      elementId: elementIdFor(2),
      kind: "axes-3d",
      geometry: {
        origin: { x: 0, y: 0 },
        xAxis: { x: 1, y: 0 },
        yAxis: { x: 0, y: 1 },
        zAxis: { x: 1, y: 1 },
        gridDivisions: 4,
      },
    };
    const table: TableElementV1 = {
      ...common,
      elementId: elementIdFor(3),
      kind: "table",
      geometry: {
        center: { x: 4, y: 5 },
        width: 8,
        height: 6,
        rotationRadians: 0,
        rowDividerOffsets: [-1, 1],
        columnDividerOffsets: [-2, 2],
      },
    };
    const frozenAxes = materializeSceneElementV1(axes);
    const frozenTable = materializeSceneElementV1(table);

    if (frozenAxes.kind !== "axes-3d" || frozenTable.kind !== "table") {
      throw new Error("Unexpected construction kind");
    }
    expect(Object.isFrozen(frozenAxes.geometry.zAxis)).toBe(true);
    expect(Object.isFrozen(frozenTable.geometry.center)).toBe(true);
    expect(Object.isFrozen(frozenTable.geometry.rowDividerOffsets)).toBe(true);
    expect(Object.isFrozen(frozenTable.geometry.columnDividerOffsets)).toBe(
      true,
    );
  });
});
