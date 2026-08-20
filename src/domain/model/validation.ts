import type { ElementBinding, TextBoundaryAnchor } from "./bindings";
import { parseBlockFingerprintV1 } from "./bindings";
import type { SceneElementV1 } from "./elements";
import type { CanonicalStyleV1 } from "./styles";
import {
  materializeConstructionStyleV1,
  materializeHighlighterStyleV1,
  materializeLinearStyleV1,
  materializePenStyleV1,
  materializeShapeStyleV1,
  parseHexRgbaV1,
} from "./styles";
import type { DataRecord } from "./validation-support";
import {
  closedRecord,
  closedValue,
  finiteNumber,
  noteCoordinate,
} from "./validation-support";

const ANCHOR_CONTEXT_IMPORT_LIMIT = 256;
const TEXT_RANGE_LIMIT = 65_536;
const BINDING_MARGIN_LIMIT = 1_024;
const STYLE_QUANTIZATION = 100;
const MIN_STROKE_WIDTH = 0.25;
const MAX_STROKE_WIDTH = 128;
const MIN_CAP_SIZE = 1;
const MAX_CAP_SIZE = 128;
type ElementKind = SceneElementV1["kind"];

function quantized(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const numeric = finiteNumber(value, name, minimum, maximum);
  const canonical =
    Math.round(numeric * STYLE_QUANTIZATION) / STYLE_QUANTIZATION;
  if (Object.is(numeric, -0) || !Object.is(canonical, numeric)) {
    throw new RangeError(`${name} must use increments of 0.01.`);
  }
  return numeric;
}

function paint(value: DataRecord): DataRecord {
  if (value.color !== "currentColor") {
    if (typeof value.color !== "string") {
      throw new TypeError("Paint color must be a string.");
    }
    parseHexRgbaV1(value.color);
  }
  quantized(value.opacity, "Stroke opacity", 0, 1);
  quantized(value.width, "Stroke width", MIN_STROKE_WIDTH, MAX_STROKE_WIDTH);
  closedValue(value.dash, ["solid", "dashed", "dotted"], "Dash pattern");
  return value;
}

function fill(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as DataRecord).kind === "none"
  ) {
    return Object.freeze(closedRecord(value, ["kind"], "Fill"));
  }
  const data = closedRecord(value, ["kind", "color", "opacity"], "Fill");
  closedValue(data.kind, ["solid"], "Fill kind");
  if (data.color !== "currentColor") {
    if (typeof data.color !== "string") {
      throw new TypeError("Fill color must be a string.");
    }
    parseHexRgbaV1(data.color);
  }
  quantized(data.opacity, "Fill opacity", 0, 1);
  return Object.freeze({ ...data });
}

function isShape(kind: ElementKind): boolean {
  return ["rectangle", "ellipse", "triangle", "diamond", "octagon"].includes(
    kind,
  );
}

function styleKeys(kind: ElementKind): readonly string[] {
  const base = ["color", "dash", "opacity", "width"];
  if (kind === "pen") {
    return [
      ...base,
      "pressure",
      "smoothing",
      "streamline",
      "strokeProfileVersion",
      "thinning",
    ];
  }
  if (kind === "highlighter") return [...base, "variant"];
  if (isShape(kind)) return [...base, "fill"];
  if (kind === "line" || kind === "arrow") {
    return [...base, "capSize", "endCap", "startCap"];
  }
  return [...base, "capSize", "positiveEndCap"];
}

export function validateCanonicalStyleV1(
  value: unknown,
  kind: ElementKind,
): CanonicalStyleV1 {
  const data = paint(closedRecord(value, styleKeys(kind), `${kind} style`));
  if (kind === "pen") {
    closedValue(data.pressure, ["constant", "pointer"], "Pen pressure");
    quantized(data.smoothing, "Pen smoothing", 0, 1);
    quantized(data.streamline, "Pen streamline", 0, 1);
    quantized(data.thinning, "Pen thinning", 0, 1);
    if (data.strokeProfileVersion !== 1 || data.dash !== "solid") {
      throw new TypeError("Pen style is not canonical V1.");
    }
    return materializePenStyleV1(
      data as unknown as Parameters<typeof materializePenStyleV1>[0],
    );
  }
  if (kind === "highlighter") {
    closedValue(data.variant, ["freehand", "straight"], "Highlighter variant");
    if (data.dash !== "solid") {
      throw new TypeError("Highlighter dash must be solid.");
    }
    return materializeHighlighterStyleV1(
      data as unknown as Parameters<typeof materializeHighlighterStyleV1>[0],
    );
  }
  if (isShape(kind)) {
    data.fill = fill(data.fill);
    return materializeShapeStyleV1(
      data as unknown as Parameters<typeof materializeShapeStyleV1>[0],
    );
  }
  quantized(data.capSize, "Cap size", MIN_CAP_SIZE, MAX_CAP_SIZE);
  const caps = ["none", "arrow", "dot", "circle", "diamond", "bar"] as const;
  if (kind === "line" || kind === "arrow") {
    closedValue(data.startCap, caps, "Start cap");
    closedValue(data.endCap, caps, "End cap");
    return materializeLinearStyleV1(
      data as unknown as Parameters<typeof materializeLinearStyleV1>[0],
    );
  }
  closedValue(data.positiveEndCap, caps, "Positive end cap");
  return materializeConstructionStyleV1(
    data as unknown as Parameters<typeof materializeConstructionStyleV1>[0],
  );
}

function anchor(value: unknown): TextBoundaryAnchor {
  const data = closedRecord(
    value,
    [
      "association",
      "blockFingerprint",
      "blockKind",
      "contextAfter",
      "contextBefore",
      "utf16Offset",
    ],
    "Text boundary anchor",
  );
  if (
    !Number.isSafeInteger(data.utf16Offset) ||
    (data.utf16Offset as number) < 0
  ) {
    throw new RangeError("Anchor offset must be a non-negative safe integer.");
  }
  closedValue(data.association, ["before", "after"], "Anchor association");
  closedValue(
    data.blockKind,
    [
      "frontmatter",
      "heading",
      "paragraph",
      "list-item",
      "blockquote",
      "code-block",
      "table",
      "thematic-break",
      "blank-line",
      "other",
    ],
    "Block kind",
  );
  for (const key of ["contextBefore", "contextAfter"] as const) {
    const context = data[key];
    if (
      typeof context !== "string" ||
      context.length > ANCHOR_CONTEXT_IMPORT_LIMIT ||
      context.normalize("NFC") !== context
    ) {
      throw new RangeError("Anchor context must be bounded NFC text.");
    }
  }
  if (typeof data.blockFingerprint !== "string") {
    throw new TypeError("Block fingerprint must be a string.");
  }
  parseBlockFingerprintV1(data.blockFingerprint);
  return Object.freeze({ ...data }) as unknown as TextBoundaryAnchor;
}

function expectedInferredConfidence(kind: unknown): "high" | "medium" | "low" {
  if (kind === "text-range") return "high";
  if (kind === "text-position") return "medium";
  return "low";
}

function validateBindingConfidence(data: DataRecord): void {
  const origin = closedValue(
    data.origin,
    ["inferred", "manual"],
    "Binding origin",
  );
  const confidence = closedValue(
    data.confidence,
    ["high", "medium", "low"],
    "Binding confidence",
  );
  if (data.inferenceProfileVersion !== 1) {
    throw new TypeError("Binding inference profile must be V1.");
  }
  const expected = expectedInferredConfidence(data.kind);
  if (
    (origin === "manual" && confidence !== "high") ||
    (origin === "inferred" && confidence !== expected)
  ) {
    throw new TypeError("Binding origin and confidence are incompatible.");
  }
}

function fixedBinding(value: unknown): ElementBinding {
  const data = closedRecord(
    value,
    [
      "anchorX",
      "anchorY",
      "confidence",
      "inferenceProfileVersion",
      "kind",
      "origin",
    ],
    "Fixed binding",
  );
  noteCoordinate(data.anchorX, "Fixed anchor X");
  noteCoordinate(data.anchorY, "Fixed anchor Y");
  validateBindingConfidence(data);
  return Object.freeze({ ...data }) as unknown as ElementBinding;
}

function positionBinding(value: unknown): ElementBinding {
  const data = closedRecord(
    value,
    [
      "anchor",
      "confidence",
      "inferenceProfileVersion",
      "kind",
      "localOffsetX",
      "localOffsetY",
      "origin",
    ],
    "Text-position binding",
  );
  data.anchor = anchor(data.anchor);
  noteCoordinate(data.localOffsetX, "Local offset X");
  noteCoordinate(data.localOffsetY, "Local offset Y");
  validateBindingConfidence(data);
  return Object.freeze({ ...data }) as unknown as ElementBinding;
}

function rangeBinding(value: unknown): ElementBinding {
  const presentation = closedValue(
    (value as DataRecord).presentation,
    ["highlight", "underline", "enclosure"],
    "Range presentation",
  );
  const keys = [
    "confidence",
    "end",
    "inferenceProfileVersion",
    "kind",
    "origin",
    "presentation",
    "start",
  ];
  const data = closedRecord(
    value,
    presentation === "enclosure" ? [...keys, "marginsInLineHeights"] : keys,
    "Text-range binding",
  );
  data.start = anchor(data.start);
  data.end = anchor(data.end);
  validateBindingConfidence(data);
  const start = (data.start as TextBoundaryAnchor).utf16Offset;
  const end = (data.end as TextBoundaryAnchor).utf16Offset;
  if (end < start || end - start > TEXT_RANGE_LIMIT) {
    throw new RangeError(
      "Text range is unordered or exceeds the V1 span limit.",
    );
  }
  if (presentation === "enclosure") {
    const margins = closedRecord(
      data.marginsInLineHeights,
      ["bottom", "left", "right", "top"],
      "Enclosure margins",
    );
    for (const key of ["top", "right", "bottom", "left"] as const) {
      finiteNumber(
        margins[key],
        `Enclosure ${key} margin`,
        -BINDING_MARGIN_LIMIT,
        BINDING_MARGIN_LIMIT,
      );
    }
    data.marginsInLineHeights = Object.freeze({ ...margins });
  }
  return Object.freeze({ ...data }) as unknown as ElementBinding;
}

export function validateElementBindingV1(value: unknown): ElementBinding {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Binding must be a data object.");
  }
  const kind = closedValue(
    (value as DataRecord).kind,
    ["text-range", "text-position", "fixed"],
    "Binding kind",
  );
  if (kind === "fixed") return fixedBinding(value);
  if (kind === "text-position") return positionBinding(value);
  return rangeBinding(value);
}
