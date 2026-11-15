// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  imageElement,
  imageSceneFixture,
  useImageSceneCleanup,
} from "../../../fixtures/rendering/image-scene";

const ownScene = useImageSceneCleanup();

it("coalesces crop samples to one mask write without traversing ten thousand retained elements", () => {
  const fixture = imageSceneFixture(10000);
  const scene = ownScene(fixture.scene);
  fixture.scheduler.runAll();
  const source = scene.svg.querySelector("defs image")!;
  const sourceWrites = vi.spyOn(source, "setAttribute");
  const visits = fixture.indexed.work.indexedVisits;
  const get = vi.spyOn(fixture.indexed.store, "get");
  const create = vi.spyOn(scene.textDocument, "createElementNS");
  const crop = scene.beginImageCrop(imageElement("image-0"), fixture.resource, vi.fn());
  const mask = scene.svg.querySelector("[data-inkbook-crop-preview] path")!;
  const writes = vi.spyOn(mask, "setAttribute");
  const allocated = create.mock.calls.length;
  // The image presentation now owns its contrast footprint alongside the shared source use.
  expect(create.mock.calls.map(([, tag]) => tag)).toEqual([
    "g",
    "svg",
    "use",
    "rect",
    "path",
    "style",
  ]);
  for (let sample = 0; sample < 30; sample += 1) {
    crop.update({ x: sample, y: sample, width: 200, height: 100 });
  }
  expect(writes).not.toHaveBeenCalled();
  fixture.scheduler.runAll();
  expect(writes).toHaveBeenCalledOnce();
  expect(create.mock.calls.length).toBe(allocated);
  expect(get).not.toHaveBeenCalled();
  expect(fixture.indexed.work.indexedVisits).toBe(visits);
  expect(sourceWrites).not.toHaveBeenCalled();
  expect(fixture.resolve).toHaveBeenCalledOnce();
  crop.dispose();
  expect(scene.svg.querySelectorAll("[data-inkbook-crop-preview]")).toHaveLength(0);
  expect(scene.svg.querySelector("defs image")).toBe(source);
});
