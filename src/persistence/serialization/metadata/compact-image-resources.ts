import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";

/** Rehydrate descriptors only from the fully allowlisted sole raster payload. */
export function* restoreCompactImageResourcesSteps(
  value: unknown,
  prelude: SafeSvgPrelude | null,
): Generator<void, boolean> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    (value.version !== 3 && value.version !== 4) ||
    !("imageResources" in value)
  )
    return false;
  if (!Array.isArray(value.imageResources)) invalidImages();
  const resources = prelude?.imageResources ?? [];
  for (let index = 0; index < value.imageResources.length; index++) {
    const resource: unknown = value.imageResources[index];
    if (
      typeof resource !== "object" ||
      resource === null ||
      Array.isArray(resource) ||
      Object.prototype.hasOwnProperty.call(resource, "data")
    )
      invalidImages();
    const descriptor = resource as Record<string, unknown>;
    const payload = resources.find((image) => image.id === descriptor.id);
    if (
      payload === undefined ||
      payload.mimeType !== descriptor.mimeType ||
      payload.width !== descriptor.width ||
      payload.height !== descriptor.height
    )
      invalidImages();
    if (Object.keys(descriptor).length !== 4) invalidImages();
    value.imageResources[index] = payload;
    yield;
  }
  return value.imageResources.length > 0;
}

function invalidImages(): never {
  throw new RangeError("Image descriptors do not match the embedded resources.");
}
