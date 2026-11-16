// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  imageElement,
  imageSceneFixture,
  useImageSceneCleanup,
} from "../../../fixtures/rendering/image-scene";
import { createSceneRecord, drainHistoryFrames } from "../../../fixtures/rendering/scene";

const ownScene = useImageSceneCleanup();

it("shares native image sources below both ink bands and retains source-pixel crop geometry", () => {
  const { scene, scheduler, resolve } = imageSceneFixture();
  ownScene(scene);
  scheduler.runAll();
  const images = scene.svg.querySelector(".inkbook-scene-images")!;
  expect(scene.mountedIds("image")).toEqual(["image-0", "image-1"]);
  expect(images.nextElementSibling).toBe(scene.svg.querySelector(".inkbook-scene-highlights"));
  expect(scene.svg.querySelectorAll("defs image")).toHaveLength(1);
  const source = scene.svg.querySelector("defs image")!;
  expect(source.getAttribute("href")).toBe("data:image/png;base64,aW1hZ2U=");
  expect(resolve).toHaveBeenCalledOnce();
  for (const viewport of images.querySelectorAll("svg")) {
    expect(viewport.getAttribute("viewBox")).toBe("10 20 400 200");
    expect(viewport.getAttribute("width")).toBe("200");
    expect(viewport.getAttribute("height")).toBe("100");
    expect(viewport.querySelector("use")!.getAttribute("href")).toBe(`#${source.id}`);
  }
});

it("commits an image-only initial viewport without requesting worker path geometry", () => {
  const { scene, scheduler, records, indexed } = imageSceneFixture(1, true, true);
  ownScene(scene);
  records.records.delete("shape");
  records.records.delete("highlight");
  const paths = vi.fn(async () => []);
  indexed.store.prepareScenePaths = paths;
  expect(scene.hasPendingSceneCommit).toBe(true);
  scheduler.runAll();
  expect(scene.mountedIds("image")).toEqual(["image-0"]);
  expect(scene.hasPendingSceneCommit).toBe(false);
  expect(scene.sceneCommitProof).toBeDefined();
  expect(paths).not.toHaveBeenCalled();
  expect(scheduler.pendingCount).toBe(0);
});

it("publishes crop and rotation previews, restores them, and commits on the retained image root", () => {
  const { scene, scheduler, records, resolve } = imageSceneFixture();
  ownScene(scene);
  scheduler.runAll();
  const before = imageElement("image-0");
  const root = scene.svg.querySelector('[data-element-id="image-0"]')!;
  const source = scene.svg.querySelector("defs image")!;
  const sourceWrites = vi.spyOn(source, "setAttribute");
  const preview = {
    ...before,
    x: 35,
    width: 180,
    rotation: 45,
    crop: { x: 40, y: 50, width: 200, height: 100 },
  };
  scene.setSelectedElements(new Set([before.id]));
  scene.setElementPreviews([preview], 1);
  scheduler.runAll();
  expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe("40 50 200 100");
  expect(root.getAttribute("transform")).toBe("rotate(45 120 70)");
  expect(scene.svg.querySelector('[data-selection-element-id="image-0"]')!.getAttribute("d")).toBe(
    "M 35 20 H 215 V 120 H 35 Z",
  );
  scene.clearElementPreviews();
  scheduler.runAll();
  expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe("10 20 400 200");
  records.records.set(preview.id, { ...createSceneRecord(preview), geometryVersion: 2 });
  scene.applyDelta({
    affected: [{ id: preview.id, before, after: preview, domains: ["geometry"] }],
  });
  scheduler.runAll();
  expect(scene.svg.querySelector('[data-element-id="image-0"]')).toBe(root);
  expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe("40 50 200 100");
  expect(sourceWrites).not.toHaveBeenCalled();
  expect(resolve).toHaveBeenCalledOnce();
});

it("releases sources when their last visible root leaves and drops all ownership on destruction", () => {
  const { scene, scheduler } = imageSceneFixture();
  ownScene(scene);
  scheduler.runAll();
  const source = scene.svg.querySelector("defs image")!;
  scene.setViewport({ left: 0, top: 10000, width: 1024, height: 500 });
  scheduler.runAll();
  expect(scene.mountedIds("image")).toEqual([]);
  expect(source.parentNode).toBeNull();
  expect(scene.svg.querySelectorAll("defs image")).toHaveLength(0);
  scene.setViewport({ left: 0, top: 0, width: 1024, height: 500 });
  scheduler.runAll();
  expect(scene.mountedIds("image")).toHaveLength(2);
  const replacement = scene.svg.querySelector("defs image")!;
  scene.destroy();
  expect(replacement.parentNode).toBeNull();
  expect(scheduler.pendingCount).toBe(0);
});

it("changes only asset references on paint commits while crop edits reuse the existing source", () => {
  const { scene, scheduler, records, resource, resolve } = imageSceneFixture();
  ownScene(scene);
  scheduler.runAll();
  const source = scene.svg.querySelector("defs image")!;
  const root = scene.svg.querySelector('[data-element-id="image-0"]')!;
  const before = imageElement("image-0");
  const crop = { ...before, crop: { x: 20, y: 40, width: 200, height: 100 } };
  records.records.set(crop.id, { ...createSceneRecord(crop), paintVersion: 2 });
  scene.applyDelta({ affected: [{ id: crop.id, before, after: crop, domains: ["paint"] }] });
  scheduler.runAll();
  expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe("20 40 200 100");
  expect(resolve).toHaveBeenCalledOnce();
  const replacement = { ...resource, id: "b".repeat(64) };
  resolve.mockImplementation((id) => (id === replacement.id ? replacement : resource));
  const after = { ...crop, assetId: replacement.id };
  records.records.set(after.id, { ...createSceneRecord(after), paintVersion: 3 });
  scene.applyDelta({ affected: [{ id: after.id, before: crop, after, domains: ["paint"] }] });
  scheduler.runAll();
  expect(scene.svg.querySelector('[data-element-id="image-0"]')).toBe(root);
  expect(scene.svg.querySelectorAll("defs image")).toHaveLength(2);
  expect(root.querySelector("use")!.getAttribute("href")).not.toBe(`#${source.id}`);
  expect(resolve).toHaveBeenCalledTimes(2);
});

it("keeps shared source ownership through removal motion and releases it when feedback ends", () => {
  const { scene, scheduler, records, resolve } = imageSceneFixture(2, false);
  ownScene(scene);
  scheduler.runAll();
  const source = scene.svg.querySelector("defs image")!;
  const before = [imageElement("image-0"), imageElement("image-1")];
  for (const element of before) records.records.delete(element.id);
  scene.applyDelta({
    affected: before.map((element) => ({
      id: element.id,
      before: element,
      after: null,
      domains: ["visibility"],
    })),
  });
  scheduler.runNext();
  expect(scene.mountedIds("image")).toHaveLength(0);
  expect(scene.svg.querySelectorAll(".inkbook-scene-motion use")).toHaveLength(2);
  expect(source.parentNode).not.toBeNull();
  expect(resolve).toHaveBeenCalledOnce();
  drainHistoryFrames(scheduler);
  expect(scene.svg.querySelectorAll(".inkbook-scene-motion use")).toHaveLength(0);
  expect(source.parentNode).toBeNull();
});
