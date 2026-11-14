import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";
import type { SafeSvgFontFace } from "../../documents/safe-svg-fonts";

/** Restore parser-owned runtime fields from the sole, already allowlisted CSS payload. */
export function* restoreCompactFontResourcesSteps(
  value: unknown,
  prelude: SafeSvgPrelude | null,
): Generator<void, boolean> {
  if (!isRecord(value) || value.version !== 2 || value.fontResources === undefined) return false;
  if (!Array.isArray(value.fontResources) || value.fontResources.length > 64) invalidFonts();
  const faces = prelude?.fontFaces ?? [];
  for (const resource of value.fontResources) {
    if (!isRecord(resource) || Object.prototype.hasOwnProperty.call(resource, "data"))
      invalidFonts();
    const face = faces.find((candidate) => matchesFace(resource, candidate));
    if (face === undefined) invalidFonts();
    resource.data = face.data;
    yield;
  }
  return value.fontResources.length > 0;
}

function matchesFace(resource: Record<string, unknown>, face: SafeSvgFontFace): boolean {
  if (
    (resource.family !== face.family &&
      (typeof resource.id !== "string" || `face-${resource.id}` !== face.family)) ||
    resource.style !== face.style ||
    resource.mimeType !== face.mimeType
  )
    return false;
  if (face.weightRange === undefined)
    return resource.weightRange === undefined && resource.weight === face.weight;
  return (
    Array.isArray(resource.weightRange) &&
    resource.weightRange.length === 2 &&
    resource.weightRange[0] === face.weightRange[0] &&
    resource.weightRange[1] === face.weightRange[1]
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFonts(): never {
  throw new RangeError("Font descriptors do not match the embedded faces.");
}
