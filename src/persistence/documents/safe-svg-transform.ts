import { parseCanonicalSvgOpacity } from "./svg-number";

const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u;

export function isSafeSvgCoordinate(value: string | undefined, maximum = 1_000_000): boolean {
  if (value === undefined || !SIGNED_DECIMAL.test(value)) return false;
  const number = Number(value);
  return Math.abs(number) <= maximum && number.toString() === value;
}

export function isSafeSvgRotation(value: string): boolean {
  const match = /^rotate\(([^ ]+) ([^ ]+) ([^ ]+)\)$/u.exec(value);
  return (
    match !== null &&
    isSafeSvgCoordinate(match[1], 360) &&
    isSafeSvgCoordinate(match[2]) &&
    isSafeSvgCoordinate(match[3])
  );
}

export function isSafeSvgPathTransform(value: string): boolean {
  const match = /^(?:(rotate\([^()]+\)) )?translate\(([^ ]+) ([^ ]+)\)$/u.exec(value);
  return (
    match !== null &&
    (match[1] === undefined || isSafeSvgRotation(match[1])) &&
    isSafeSvgCoordinate(match[2]) &&
    isSafeSvgCoordinate(match[3])
  );
}

export function validStrokeGroupAttributes(attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.size < 1 || attributes.size > 2) return false;
  if ([...attributes.keys()].some((name) => name !== "opacity" && name !== "transform"))
    return false;
  const opacity = attributes.get("opacity");
  if (opacity !== undefined && parseCanonicalSvgOpacity(opacity) === null) return false;
  const transform = attributes.get("transform");
  if (transform === undefined) return opacity !== undefined;
  const match = /^translate\(([^ ]+) ([^ ]+)\)$/u.exec(transform);
  return match !== null && match.slice(1).every((value) => isSafeSvgCoordinate(value));
}
