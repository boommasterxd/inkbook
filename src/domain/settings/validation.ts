import {
  ARROW_NODES,
  CLOSED_SHAPE_TOOLS,
  OUTLINE_ONLY_TOOLS,
  OUTLINE_STYLES,
  OUTLINE_WIDTHS,
  PEN_WIDTHS,
  SELECTION_AREAS,
  SELECTION_INCLUSIONS,
  type ColorV1,
  type HighlighterDefaultsV1,
  type OutlineDefaultsV1,
  type PenDefaultsV1,
  type SettingsDiagnostic,
  type ShapeDefaultsV1,
  type ToolDefaultsV1,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const RGBA_COLORS = new Set([
  "#EF4444FF",
  "#F97316FF",
  "#EAB308FF",
  "#22C55EFF",
  "#06B6D4FF",
  "#3B82F6FF",
  "#8B5CF6FF",
  "#EC4899FF",
  "#6B7280FF",
]);

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: unknown, keys: readonly string[]): value is UnknownRecord {
  if (!isRecord(value)) return false;
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > keys.length || !keys.includes(key)) return false;
  }
  return (
    count === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function isOneOf<T>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.includes(value as T);
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

export function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isInteger(value) && isNumberInRange(value, minimum, maximum);
}

function isColor(value: unknown): value is ColorV1 {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "theme-text") return hasExactKeys(value, ["type"]);
  return (
    value.type === "rgba" &&
    hasExactKeys(value, ["type", "value"]) &&
    typeof value.value === "string" &&
    RGBA_COLORS.has(value.value)
  );
}

function invalid(diagnostics: SettingsDiagnostic[], path: string): void {
  diagnostics.push({ code: "settings.invalid-field", path });
}

export function validOrDefault<T>(
  input: unknown,
  fallback: T,
  predicate: (value: unknown) => value is T,
  diagnostics: SettingsDiagnostic[],
  path: string,
): T {
  if (predicate(input)) return structuredClone(input);
  invalid(diagnostics, path);
  return structuredClone(fallback);
}

function loadPen(
  input: unknown,
  fallback: PenDefaultsV1,
  diagnostics: SettingsDiagnostic[],
): PenDefaultsV1 {
  if (!hasExactKeys(input, ["color", "width", "opacity", "pressureEnabled"])) {
    invalid(diagnostics, "toolDefaults.pen");
    return structuredClone(fallback);
  }
  return {
    color: validOrDefault(
      input.color,
      fallback.color,
      isColor,
      diagnostics,
      "toolDefaults.pen.color",
    ),
    width: validOrDefault(
      input.width,
      fallback.width,
      (value): value is PenDefaultsV1["width"] => isOneOf(value, PEN_WIDTHS),
      diagnostics,
      "toolDefaults.pen.width",
    ),
    opacity: validOrDefault(
      input.opacity,
      fallback.opacity,
      (value): value is number => isNumberInRange(value, 0, 1),
      diagnostics,
      "toolDefaults.pen.opacity",
    ),
    pressureEnabled: validOrDefault(
      input.pressureEnabled,
      fallback.pressureEnabled,
      (value): value is boolean => typeof value === "boolean",
      diagnostics,
      "toolDefaults.pen.pressureEnabled",
    ),
  };
}

function loadHighlighter(
  input: unknown,
  fallback: HighlighterDefaultsV1,
  diagnostics: SettingsDiagnostic[],
  path: string,
): HighlighterDefaultsV1 {
  if (!hasExactKeys(input, ["color", "width", "opacity"])) {
    invalid(diagnostics, path);
    return structuredClone(fallback);
  }
  return {
    color: validOrDefault(input.color, fallback.color, isColor, diagnostics, `${path}.color`),
    width: validOrDefault(
      input.width,
      fallback.width,
      (value): value is HighlighterDefaultsV1["width"] => isOneOf(value, PEN_WIDTHS),
      diagnostics,
      `${path}.width`,
    ),
    opacity: validOrDefault(
      input.opacity,
      fallback.opacity,
      (value): value is number => isNumberInRange(value, 0, 1),
      diagnostics,
      `${path}.opacity`,
    ),
  };
}

function loadOutlineFields(
  input: UnknownRecord,
  fallback: OutlineDefaultsV1,
  diagnostics: SettingsDiagnostic[],
  path: string,
): OutlineDefaultsV1 {
  return {
    outlineColor: validOrDefault(
      input.outlineColor,
      fallback.outlineColor,
      isColor,
      diagnostics,
      `${path}.outlineColor`,
    ),
    outlineWidth: validOrDefault(
      input.outlineWidth,
      fallback.outlineWidth,
      (value): value is OutlineDefaultsV1["outlineWidth"] => isOneOf(value, OUTLINE_WIDTHS),
      diagnostics,
      `${path}.outlineWidth`,
    ),
    outlineStyle: validOrDefault(
      input.outlineStyle,
      fallback.outlineStyle,
      (value): value is OutlineDefaultsV1["outlineStyle"] => isOneOf(value, OUTLINE_STYLES),
      diagnostics,
      `${path}.outlineStyle`,
    ),
    outlineOpacity: validOrDefault(
      input.outlineOpacity,
      fallback.outlineOpacity,
      (value): value is number => isNumberInRange(value, 0, 1),
      diagnostics,
      `${path}.outlineOpacity`,
    ),
  };
}

function loadOutline(
  input: unknown,
  fallback: OutlineDefaultsV1,
  diagnostics: SettingsDiagnostic[],
  path: string,
): OutlineDefaultsV1 {
  if (!hasExactKeys(input, ["outlineColor", "outlineWidth", "outlineStyle", "outlineOpacity"])) {
    invalid(diagnostics, path);
    return structuredClone(fallback);
  }
  return loadOutlineFields(input, fallback, diagnostics, path);
}

function loadShape(
  input: unknown,
  fallback: ShapeDefaultsV1,
  diagnostics: SettingsDiagnostic[],
  path: string,
): ShapeDefaultsV1 {
  const keys = [
    "outlineColor",
    "outlineWidth",
    "outlineStyle",
    "outlineOpacity",
    "fillColor",
    "fillOpacity",
  ];
  if (!hasExactKeys(input, keys)) {
    invalid(diagnostics, path);
    return structuredClone(fallback);
  }
  return {
    ...loadOutlineFields(input, fallback, diagnostics, path),
    fillColor: validOrDefault(
      input.fillColor,
      fallback.fillColor,
      (value): value is ColorV1 | null => value === null || isColor(value),
      diagnostics,
      `${path}.fillColor`,
    ),
    fillOpacity: validOrDefault(
      input.fillOpacity,
      fallback.fillOpacity,
      (value): value is number => isNumberInRange(value, 0, 1),
      diagnostics,
      `${path}.fillOpacity`,
    ),
  };
}

function loadShapes(
  input: unknown,
  fallback: ToolDefaultsV1["shapes"],
  diagnostics: SettingsDiagnostic[],
): ToolDefaultsV1["shapes"] {
  const tools = [...CLOSED_SHAPE_TOOLS, ...OUTLINE_ONLY_TOOLS];
  if (!hasExactKeys(input, tools)) {
    invalid(diagnostics, "toolDefaults.shapes");
    return structuredClone(fallback);
  }
  const result = {} as ToolDefaultsV1["shapes"];
  for (const tool of CLOSED_SHAPE_TOOLS) {
    result[tool] = loadShape(
      input[tool],
      fallback[tool],
      diagnostics,
      `toolDefaults.shapes.${tool}`,
    );
  }
  for (const tool of OUTLINE_ONLY_TOOLS) {
    result[tool] = loadOutline(
      input[tool],
      fallback[tool],
      diagnostics,
      `toolDefaults.shapes.${tool}`,
    );
  }
  return result;
}

export function loadToolDefaults(
  input: unknown,
  fallback: ToolDefaultsV1,
  diagnostics: SettingsDiagnostic[],
): ToolDefaultsV1 {
  const keys = [
    "select",
    "pen",
    "highlighter",
    "straightHighlighter",
    "eraser",
    "shapes",
    "arrow",
    "coordinateSystem",
    "table",
  ];
  if (!hasExactKeys(input, keys)) {
    invalid(diagnostics, "toolDefaults");
    return structuredClone(fallback);
  }
  return {
    select: validOrDefault(
      input.select,
      fallback.select,
      (value): value is ToolDefaultsV1["select"] =>
        hasExactKeys(value, ["area", "inclusion"]) &&
        isOneOf(value.area, SELECTION_AREAS) &&
        isOneOf(value.inclusion, SELECTION_INCLUSIONS),
      diagnostics,
      "toolDefaults.select",
    ),
    pen: loadPen(input.pen, fallback.pen, diagnostics),
    highlighter: loadHighlighter(
      input.highlighter,
      fallback.highlighter,
      diagnostics,
      "toolDefaults.highlighter",
    ),
    straightHighlighter: loadHighlighter(
      input.straightHighlighter,
      fallback.straightHighlighter,
      diagnostics,
      "toolDefaults.straightHighlighter",
    ),
    eraser: validOrDefault(
      input.eraser,
      fallback.eraser,
      (value): value is { radius: number } =>
        hasExactKeys(value, ["radius"]) && isIntegerInRange(value.radius, 8, 64),
      diagnostics,
      "toolDefaults.eraser",
    ),
    shapes: loadShapes(input.shapes, fallback.shapes, diagnostics),
    arrow: validOrDefault(
      input.arrow,
      fallback.arrow,
      (value): value is ToolDefaultsV1["arrow"] =>
        hasExactKeys(value, ["startNode", "endNode"]) &&
        isOneOf(value.startNode, ARROW_NODES) &&
        isOneOf(value.endNode, ARROW_NODES),
      diagnostics,
      "toolDefaults.arrow",
    ),
    coordinateSystem: validOrDefault(
      input.coordinateSystem,
      fallback.coordinateSystem,
      (value): value is ToolDefaultsV1["coordinateSystem"] =>
        hasExactKeys(value, ["dimension"]) && isOneOf(value.dimension, ["2d", "3d"] as const),
      diagnostics,
      "toolDefaults.coordinateSystem",
    ),
    table: validOrDefault(
      input.table,
      fallback.table,
      (value): value is ToolDefaultsV1["table"] =>
        hasExactKeys(value, ["columns"]) && isIntegerInRange(value.columns, 1, 12),
      diagnostics,
      "toolDefaults.table",
    ),
  };
}
