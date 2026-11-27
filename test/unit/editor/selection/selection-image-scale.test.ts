import { expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";
import { imageElement } from "../../../fixtures/domain/images";

it("scales a cropped image around its fixed corner without changing its source pixels", () => {
  const image = { ...imageElement(), crop: { x: 50, y: 25, width: 200, height: 100 } };
  const anchor = { x: image.x, y: image.y };
  const store = new ElementStore([image]);
  const handle = new SelectionHandleSession({
    action: { anchor, kind: "scale", position: "bottom-right", rotation: 0 },
    elements: [image],
    planner: store,
    startPointer: { x: 300, y: 300 },
  });
  const preview = handle.update({ x: 500, y: 370 });
  const commit = handle.prepareCommit();
  if (commit.status !== "ready") throw new Error(`Image scale was not ready: ${commit.status}`);
  expect(preview.exactElements).toEqual(commit.replacements);
  expect(commit.replacements).toHaveLength(1);
  const scaled = commit.replacements[0];
  if (scaled?.kind !== "image") throw new Error("Expected a scaled image.");
  expect(scaled).toMatchObject({
    id: image.id,
    ...anchor,
    assetId: image.assetId,
    crop: image.crop,
  });
  expect(scaled.width).toBeGreaterThan(image.width);
  expect(scaled.width / scaled.height).toBeCloseTo(image.width / image.height, 4);
});
