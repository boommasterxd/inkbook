// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { applyImageCrop } from "../../../../src/domain/images/image-crop";
import {
  imageElement,
  imageSceneFixture,
  useImageSceneCleanup,
} from "../../../fixtures/rendering/image-scene";

const ownScene = useImageSceneCleanup();

it("reveals the stationary rotated source in its image band and masks only excluded pixels", () => {
  const fixture = imageSceneFixture();
  const scene = ownScene(fixture.scene);
  fixture.scheduler.runAll();
  const image = { ...imageElement("image-0"), rotation: 90 };
  const full = applyImageCrop(image, { x: 0, y: 0, width: 640, height: 480 });
  const source = scene.svg.querySelector("defs image")!;
  const sourceWrites = vi.spyOn(source, "setAttribute");
  const camera = vi.fn();
  scene.svg.setAttribute("data-inkbook-image-crop", "previous");
  const crop = scene.beginImageCrop(image, fixture.resource, camera);
  const root = scene.svg.querySelector("[data-inkbook-crop-preview]")!;
  expect(root.parentNode).toBe(scene.svg.querySelector(".inkbook-scene-images"));
  expect(root.getAttribute("transform")).toBe(`rotate(90 ${full.pivot.x} ${full.pivot.y})`);
  expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 640 480");
  expect(root.querySelector("svg")!.getAttribute("x")).toBe(String(full.x));
  expect(root.querySelector("use")!.getAttribute("href")).toBe(`#${source.id}`);
  const draft = { x: 40, y: 60, width: 200, height: 100 };
  crop.update(draft);
  fixture.scheduler.runAll();
  const mask = root.querySelector("path")!;
  expect(mask.getAttribute("fill-rule")).toBe("evenodd");
  expect(mask.getAttribute("d")).toBe(
    `M ${full.x} ${full.y} h 320 v 240 h -320 Z M ${full.x + 20} ${full.y + 30} h 100 v 50 h -100 Z `,
  );
  scene.setCamera({ x: 10, zoom: 2 });
  expect(camera.mock.calls).toEqual([[{ x: 0, zoom: 1 }], [{ x: 10, zoom: 2 }]]);
  expect(sourceWrites).not.toHaveBeenCalled();
  expect(fixture.resolve).toHaveBeenCalledOnce();
  crop.dispose();
  crop.dispose();
  expect(root.parentNode).toBeNull();
  expect(scene.svg.getAttribute("data-inkbook-image-crop")).toBe("previous");
  expect(source.parentNode).not.toBeNull();
});

it("replaces the previous crop lease and releases pending and offscreen ownership on disposal", () => {
  const fixture = imageSceneFixture();
  const scene = ownScene(fixture.scene);
  fixture.scheduler.runAll();
  const stale = scene.beginImageCrop(imageElement("image-0"), fixture.resource, vi.fn());
  const crop = scene.beginImageCrop(imageElement("image-1"), fixture.resource, vi.fn());
  stale.dispose();
  stale.update({ x: 0, y: 0, width: 1, height: 1 });
  expect(scene.svg.querySelectorAll("[data-inkbook-crop-preview]")).toHaveLength(1);
  expect(scene.svg.hasAttribute("data-inkbook-image-crop")).toBe(true);
  scene.setViewport({ left: 0, top: 10000, width: 1024, height: 500 });
  fixture.scheduler.runAll();
  expect(scene.mountedIds("image")).toEqual([]);
  expect(scene.svg.querySelectorAll("defs image")).toHaveLength(1);
  crop.update({ x: 0, y: 0, width: 640, height: 480 });
  scene.destroy();
  expect(scene.svg.querySelectorAll("[data-inkbook-crop-preview], defs image")).toHaveLength(0);
  expect(scene.svg.hasAttribute("data-inkbook-image-crop")).toBe(false);
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(() => scene.beginImageCrop(imageElement(), fixture.resource, vi.fn())).toThrow("disposed");
});

it("releases its presentation when the initial camera callback fails", () => {
  const fixture = imageSceneFixture();
  const scene = ownScene(fixture.scene);
  fixture.scheduler.runAll();
  expect(() =>
    scene.beginImageCrop(imageElement(), fixture.resource, () => {
      throw new Error("detached host");
    }),
  ).toThrow("detached host");
  expect(scene.svg.querySelectorAll("[data-inkbook-crop-preview]")).toHaveLength(0);
  expect(scene.svg.hasAttribute("data-inkbook-image-crop")).toBe(false);
});

it("draws transparent pixels once and retains overlap order when the original is culled and remounted", () => {
  const fixture = imageSceneFixture();
  fixture.resource.data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=";
  const scene = ownScene(fixture.scene);
  fixture.scheduler.runAll();
  const owner = scene.textDocument.defaultView!;
  const original = scene.svg.querySelector('[data-element-id="image-0"]')!;
  const other = scene.svg.querySelector('[data-element-id="image-1"]')!;
  const priorVisibility = owner.getComputedStyle(original).visibility;
  const crop = scene.beginImageCrop(imageElement("image-0"), fixture.resource, vi.fn());
  const preview = scene.svg.querySelector("[data-inkbook-crop-preview]")!;
  expect(owner.getComputedStyle(original).visibility).toBe("hidden");
  expect(owner.getComputedStyle(other).visibility).not.toBe("hidden");
  expect(owner.getComputedStyle(preview).visibility).not.toBe("hidden");
  expect(original.nextElementSibling).toBe(preview);
  expect(preview.nextElementSibling).toBe(other);
  scene.setViewport({ left: 0, top: 10000, width: 1024, height: 500 });
  fixture.scheduler.runAll();
  expect(original.parentNode).toBeNull();
  scene.setViewport({ left: 0, top: 0, width: 1024, height: 500 });
  fixture.scheduler.runAll();
  const remounted = scene.svg.querySelector('[data-element-id="image-0"]')!;
  expect(owner.getComputedStyle(remounted).visibility).toBe("hidden");
  expect(remounted.nextElementSibling).toBe(preview);
  expect(preview.nextElementSibling?.getAttribute("data-element-id")).toBe("image-1");
  crop.dispose();
  expect(owner.getComputedStyle(remounted).visibility).toBe(priorVisibility);
  expect(preview.parentNode).toBeNull();
});
