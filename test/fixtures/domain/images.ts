import type { ImageElementV3, ImageResourceV3 } from "../../../src/domain/schema/public";

export function imageResource(): ImageResourceV3 {
  return {
    id: "a".repeat(64),
    mimeType: "image/png",
    width: 400,
    height: 200,
    data: "AA==",
  };
}

export function imageElement(): ImageElementV3 {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    createdAt: 0,
    kind: "image",
    x: 100,
    y: 200,
    width: 200,
    height: 100,
    rotation: 0,
    pivot: { x: 200, y: 250 },
    assetId: imageResource().id,
    crop: { x: 0, y: 0, width: 400, height: 200 },
  };
}
