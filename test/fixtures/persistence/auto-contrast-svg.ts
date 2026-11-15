import type { ImageElementV3, StrokeElementV1 } from "../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/document-codec";
import { imageElement } from "../domain/images";
import { rasterResource } from "./image-svg";
import { createTestStroke, createWorkerSnapshot } from "./worker-snapshot";

export function autoContrastSvg(
  options: {
    readonly image?: Partial<ImageElementV3>;
    readonly stroke?: Partial<StrokeElementV1>;
  } = {},
): string {
  const resource = rasterResource();
  const image = {
    ...imageElement(),
    assetId: resource.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    ...options.image,
  };
  const stroke = { ...createTestStroke(), ...options.stroke };
  const output = serializeInkbookDocument({
    ...createWorkerSnapshot([image, stroke]),
    version: 5,
    imageResources: [resource],
  });
  if (!output.ok) throw new Error(output.error.message);
  return output.value.svg;
}
