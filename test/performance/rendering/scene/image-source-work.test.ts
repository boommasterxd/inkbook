// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { imageSceneFixture, useImageSceneCleanup } from "../../../fixtures/rendering/image-scene";

const ownScene = useImageSceneCleanup();

it("bounds decoded sources by visible resources and writes no source during repeated transforms", () => {
  const fixture = imageSceneFixture(2000);
  const scene = ownScene(fixture.scene);
  let encodedReads = 0;
  Object.defineProperty(fixture.resource, "data", {
    get: () => {
      encodedReads += 1;
      return "aW1hZ2U=";
    },
  });
  const sourceWrites: string[] = [];
  const create = scene.textDocument.createElementNS.bind(scene.textDocument);
  vi.spyOn(scene.textDocument, "createElementNS").mockImplementation((namespace, name, options) => {
    const node = create(namespace, name, options);
    if (name === "image") {
      const write = node.setAttribute.bind(node);
      vi.spyOn(node, "setAttribute").mockImplementation((attribute, value) => {
        if (attribute === "href") sourceWrites.push(value);
        write(attribute, value);
      });
    }
    return node;
  });
  fixture.scheduler.runAll();
  expect(scene.mountedIds("image")).toHaveLength(2);
  expect(fixture.indexed.work.indexedVisits).toBeLessThan(100);
  expect(sourceWrites).toEqual(["data:image/png;base64,aW1hZ2U="]);
  expect(fixture.resolve).toHaveBeenCalledOnce();
  expect(encodedReads).toBe(1);
  const initialReads = encodedReads;
  const source = scene.svg.querySelector("defs image")!;
  const queryWork = fixture.indexed.work.indexedVisits;
  for (let sample = 0; sample < 30; sample += 1) {
    scene.setPreviewTransform(["image-0", "image-1"], `translate(${sample} 0)`, sample + 1);
    scene.flushPointerFeedbackFrame();
  }
  expect(encodedReads).toBe(initialReads);
  expect(sourceWrites).toHaveLength(1);
  expect(scene.svg.querySelector("defs image")).toBe(source);
  expect(fixture.indexed.work.indexedVisits).toBe(queryWork);
  scene.clearPreviewTransforms();
  fixture.scheduler.runAll();
  scene.setViewport({ left: 0, top: 1_000_000, width: 1024, height: 500 });
  fixture.scheduler.runAll();
  expect(scene.mountedIds("image")).toHaveLength(0);
  expect(scene.svg.querySelectorAll("defs image")).toHaveLength(0);
  expect(source.parentNode).toBeNull();
  scene.destroy();
  expect(fixture.scheduler.pendingCount).toBe(0);
});
