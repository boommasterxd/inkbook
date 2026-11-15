import { isSafeSvgCoordinate, isSafeSvgRotation } from "./safe-svg-transform";

export type SafeAutoPaintBox = Readonly<Record<"x" | "y" | "width" | "height", string>>;

export interface SafeAutoPaintServer {
  readonly id: string;
  readonly box: SafeAutoPaintBox;
}

export interface SafeAutoPaintReferences {
  readonly servers: ReadonlyMap<string, SafeAutoPaintServer>;
  readonly used: Set<string>;
}

export interface SafeAutoTile {
  readonly paintId: string;
  readonly box: SafeAutoPaintBox;
}

export type SafeAutoPaintMode = "fill" | "stroke" | "stroke-fill";
export interface SafeAutoGeometryReference {
  readonly id: string;
  readonly paint: SafeAutoPaintMode;
}

export function safeAutoPaintMode(className: string | undefined): SafeAutoPaintMode | null {
  switch (className) {
    case "inkbook-auto-fill":
      return "fill";
    case "inkbook-auto-stroke":
      return "stroke";
    case "inkbook-auto-stroke-fill":
      return "stroke-fill";
    default:
      return null;
  }
}

/** Inheritance exists only inside a bound geometry definition, never on ordinary ink. */
export function isSafeAutoGeometryPaint(attributes: ReadonlyMap<string, string>): boolean {
  const paint = attributes.get("class");
  const autoFill = paint === "inkbook-auto-fill" || paint === "inkbook-auto-stroke-fill";
  const autoStroke = paint === "inkbook-auto-stroke" || paint === "inkbook-auto-stroke-fill";
  return (
    (autoFill || autoStroke) &&
    (attributes.get("fill") === "inherit") === autoFill &&
    (attributes.get("stroke") === "inherit") === autoStroke
  );
}

/** Only inverse translations and one pivot rotation can compensate canonical local geometry. */
export function isSafeAutoPatternTransform(value: string): boolean {
  const parts = value.match(/(?:translate|rotate)\([^()]+\)/gu);
  if (parts === null || parts.length > 3 || parts.join(" ") !== value) return false;
  let rotations = 0;
  let translations = 0;
  for (const part of parts) {
    if (part.startsWith("rotate(")) {
      if (++rotations > 1 || !isSafeSvgRotation(part)) return false;
    } else {
      const coordinates = part.slice(10, -1).split(" ");
      if (
        ++translations > 2 ||
        coordinates.length !== 2 ||
        !coordinates.every((coordinate) => isSafeSvgCoordinate(coordinate))
      )
        return false;
    }
  }
  return true;
}
