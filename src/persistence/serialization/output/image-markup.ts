import type { ImageElementV3, ImageResourceV3, InkSnapshotV1 } from "../../../domain/schema/public";
import { serializeSvgNumber as number } from "../../documents/svg-number";
import { usedImageResourcesSteps } from "../../images/used-image-resources";
import { canonicalImageResource } from "../../images/image-resources";

export function serializeImageMarkup(image: ImageElementV3): string {
  const crop = image.crop;
  return (
    `<g transform="rotate(${number(image.rotation)} ${number(image.pivot.x)} ${number(image.pivot.y)})">` +
    `<svg x="${number(image.x)}" y="${number(image.y)}" width="${number(image.width)}" height="${number(image.height)}" ` +
    `viewBox="${number(crop.x)} ${number(crop.y)} ${number(crop.width)} ${number(crop.height)}" overflow="hidden" preserveAspectRatio="none">` +
    `<use href="#inkbook-image-${image.assetId}"/></svg></g>`
  );
}

export function* imageDefinitionsFragments(
  resources: readonly ImageResourceV3[],
): Iterable<string> {
  if (resources.length === 0) return;
  yield '<defs id="inkbook-images">';
  for (const resource of resources) {
    yield `<image id="inkbook-image-${resource.id}" width="${resource.width}" height="${resource.height}" href="data:${resource.mimeType};base64,`;
    for (let offset = 0; offset < resource.data.length; offset += 64 * 1024)
      yield resource.data.slice(offset, offset + 64 * 1024);
    yield '"/>';
  }
  yield "</defs>";
}

export function imageDefinitionsMarkup(resources: readonly ImageResourceV3[]): string {
  return [...imageDefinitionsFragments(resources)].join("");
}

export function snapshotImageResources(
  snapshot: InkSnapshotV1,
  validatedSnapshot = false,
): {
  imageResources?: ImageResourceV3[];
} {
  if (snapshot.version < 3) return {};
  // Only authoritative schema-validated callers may attest that absent resources prove no images.
  if (validatedSnapshot && (snapshot.imageResources?.length ?? 0) === 0) return {};
  const steps = usedImageResourcesSteps(snapshot.elements, snapshot.imageResources ?? []);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value.length === 0 ? {} : { imageResources: step.value.map(canonicalImageResource) };
}
