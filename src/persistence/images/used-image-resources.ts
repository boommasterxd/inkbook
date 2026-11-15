import type { ImageResourceV3, InkElementV1 } from "../../domain/schema/public";

export function* usedImageResourcesSteps(
  elements: Iterable<InkElementV1>,
  resources: readonly ImageResourceV3[],
): Generator<void, ImageResourceV3[]> {
  const available = new Map(resources.map((resource) => [resource.id, resource]));
  const used = new Set<string>();
  for (const element of elements) {
    if (element.kind === "image") {
      const resource = available.get(element.assetId);
      if (
        resource === undefined ||
        element.crop.x + element.crop.width > resource.width ||
        element.crop.y + element.crop.height > resource.height
      )
        throw new RangeError("Required image resource or crop is invalid.");
      used.add(resource.id);
    }
    yield;
  }
  return resources.filter((resource) => used.has(resource.id));
}
