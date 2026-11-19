import { IMAGE_LIMITS } from "../images/image-limits";
import type { ImageCropV3, ImageElementV3, ImageResourceV3, InkElementV1 } from "./types";
import {
  assertResourceDataSteps,
  matchesResourceDataSteps,
  resourceEntries,
  validatedResourceDataBytes,
} from "./resource-validation";
import {
  assertBoxGeometry,
  assertExactKeys,
  assertGeometryNumber,
  assertIntegerRange,
  assertOneOf,
  assertRecord,
  fail,
  type UnknownRecord,
  type ValidationContext,
} from "./validation-internals";

export function assertImageElement(
  value: UnknownRecord,
  path: string,
  context: ValidationContext,
): void {
  assertExactKeys(
    value,
    [
      "id",
      "kind",
      "createdAt",
      "rotation",
      "pivot",
      ...(value.locked === undefined ? [] : ["locked"]),
      "x",
      "y",
      "width",
      "height",
      "assetId",
      "crop",
    ],
    path,
  );
  assertBoxGeometry(value, path, context.limits.absoluteCoordinate);
  if ((value.width as number) <= 0 || (value.height as number) <= 0)
    fail("invalid-range", path, "Image dimensions must be positive.");
  assertImageResourceId(value.assetId, `${path}.assetId`);
  assertImageCrop(value.crop, `${path}.crop`);
}

function assertImageResourceId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    fail("invalid-range", path, "Image identifiers must be lowercase SHA-256 digests.");
}

function assertImageCrop(value: unknown, path: string): asserts value is ImageCropV3 {
  assertRecord(value, path);
  assertExactKeys(value, ["x", "y", "width", "height"], path);
  for (const key of ["x", "y", "width", "height"] as const) {
    assertGeometryNumber(value[key], `${path}.${key}`, IMAGE_LIMITS.resourceAxis);
    if (value[key] < (key === "x" || key === "y" ? 0 : 0.001))
      fail("invalid-range", `${path}.${key}`, "Image crop geometry is outside the valid range.");
  }
}

/** Previous entries may only come from the caller's own fully validated registry. */
export function* assertImageResourcesSteps(
  value: unknown,
  path: string,
  previous?: ReadonlyMap<string, ImageResourceV3>,
): Generator<void, Map<string, ImageResourceV3>> {
  if (!Array.isArray(value) || value.length > IMAGE_LIMITS.resources)
    fail("invalid-range", path, "Image resources must be a bounded array.");
  const ids = new Set<string>();
  const retained = new Map<string, ImageResourceV3>();
  let bytes = 0;
  let pixels = 0;
  for (const { resource, location } of resourceEntries(value, path)) {
    assertExactKeys(resource, ["id", "mimeType", "width", "height", "data"], location);
    assertImageResourceId(resource.id, `${location}.id`);
    if (ids.has(resource.id)) fail("duplicate-id", `${location}.id`, "Duplicate image resource.");
    ids.add(resource.id);
    assertOneOf(
      resource.mimeType,
      ["image/png", "image/jpeg", "image/webp"] as const,
      `${location}.mimeType`,
    );
    assertIntegerRange(resource.width, 1, IMAGE_LIMITS.resourceAxis, `${location}.width`);
    assertIntegerRange(resource.height, 1, IMAGE_LIMITS.resourceAxis, `${location}.height`);
    if (resource.width * resource.height > IMAGE_LIMITS.resourcePixels)
      fail("invalid-range", location, "Image pixel capacity exceeded.");
    pixels += resource.width * resource.height;
    if (pixels > IMAGE_LIMITS.documentPixels)
      fail("invalid-range", path, "Document image pixel capacity exceeded.");
    const existing = previous?.get(resource.id);
    if (existing !== undefined && (yield* matchesPreviousImageSteps(resource, existing))) {
      retained.set(existing.id, existing);
      bytes += validatedResourceDataBytes(existing.data);
    } else {
      bytes += yield* assertResourceDataSteps(resource.data, `${location}.data`, {
        maximumBytes: IMAGE_LIMITS.resourceBytes,
        canonicalPadding: true,
        malformedMessage: "Image resources require canonical Base64 data.",
        capacityMessage: "Image resource byte capacity exceeded.",
      });
    }
    if (bytes > IMAGE_LIMITS.documentBytes)
      fail("invalid-range", path, "Document image byte capacity exceeded.");
    yield;
  }
  return retained;
}

function* matchesPreviousImageSteps(
  resource: UnknownRecord,
  previous: ImageResourceV3,
): Generator<void, boolean> {
  return (
    resource === (previous as unknown) ||
    (resource.mimeType === previous.mimeType &&
      resource.width === previous.width &&
      resource.height === previous.height &&
      (yield* matchesResourceDataSteps(resource.data, previous.data)))
  );
}

export function* assertImageBindingsSteps(
  elements: readonly InkElementV1[],
  resources: readonly ImageResourceV3[],
): Generator<void, void> {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  for (let index = 0; index < elements.length; index += 1) {
    const image = elements[index]!;
    if (image.kind === "image") assertImageBinding(image, byId.get(image.assetId), index);
    if ((index + 1) % 128 === 0) yield;
  }
}

export function assertImageBinding(
  image: ImageElementV3,
  resource: ImageResourceV3 | undefined,
  index: number,
): void {
  if (resource === undefined)
    fail("invalid-range", `$.elements[${index}].assetId`, "Image resource is missing.");
  if (
    image.crop.x + image.crop.width > resource.width ||
    image.crop.y + image.crop.height > resource.height
  )
    fail("invalid-range", `$.elements[${index}].crop`, "Image crop exceeds its source dimensions.");
}
