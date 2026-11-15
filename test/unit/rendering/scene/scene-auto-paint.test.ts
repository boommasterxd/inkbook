import { describe, expect, it } from "vitest";
import { autoPaintFixture } from "../../../fixtures/rendering/auto-paint";
import { fakeNode, fakeRectangleRecord } from "./fakes";
import {
  autoPaintTransform,
  inverseAutoPaintTransform,
  autoPaintMinimumStride,
} from "../../../../src/rendering/scene/auto-paint-transform";
import {
  writeMotionStyle,
  clearMotionStyle,
} from "../../../../src/rendering/scene/presentation/motion-visual";
import { writeAutoPaintBounds } from "../../../../src/rendering/scene/content/auto-paint-bounds";
import { readAutoPaintBounds } from "../../../../src/rendering/scene/content/auto-paint-bounds";
import {
  createMountedElement,
  updateMountedElementPreview,
} from "../../../../src/rendering/scene/content/mounted-element";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";

describe("Auto paint publication", () => {
  it("defers a newly admitted offscreen atom's source server until camera reentry", () => {
    const fixture = autoPaintFixture();
    fixture.setCamera({ x: -500_000, zoom: 1 });
    const node = fixture.mount();
    fixture.flush();
    const filters = () => fixture.paintNodes().filter((entry) => entry.tagName === "filter");
    expect(filters()).toHaveLength(1);
    const id = node.style.getPropertyValue("--inkbook-auto-paint").slice(5, -1);
    const alias = fixture.paintNodes().find((entry) => entry.attributes.get("id") === id)!;
    expect(alias.attributes.get("href")).toBeUndefined();
    fixture.setCamera({ x: 0, zoom: 1 });
    fixture.flush();
    expect(filters().map((entry) => entry.attributes.get("width"))).toEqual(["44", undefined]);
    expect(alias.attributes.get("href")).toMatch(/^#inkbook-scene-auto-/);
    fixture.manager.release();
    expect(fixture.paintNodes()).toHaveLength(0);
    expect(fixture.manager.memoryUsage()).toBe(0);
  });
  it("retains the small lease when a camera jump leaves an old mounted atom offscreen", () => {
    const fixture = autoPaintFixture();
    const node = fixture.mount();
    fixture.flush();
    const created = fixture.fake.created;
    const paint = node.style.getPropertyValue("--inkbook-auto-paint");
    fixture.setCamera({ x: -500_000, zoom: 1 });
    fixture.flush();
    expect(fixture.fake.created).toBe(created);
    expect(node.style.getPropertyValue("--inkbook-auto-paint")).toBe(paint);
    const filters = fixture.paintNodes().filter((entry) => entry.tagName === "filter");
    expect(filters.map((entry) => entry.attributes.get("width"))).toEqual(["44", undefined]);
    fixture.setCamera({ x: 0, zoom: 1 });
    fixture.flush();
    expect(fixture.fake.created).toBe(created);
    fixture.manager.release();
  });
  it("updates the sampled region when a geometry preview grows beyond its original bounds", () => {
    const fixture = autoPaintFixture();
    const initial = fakeRectangleRecord("resize", 0, 100);
    if (initial.element.kind !== "rectangle") throw new Error("Expected rectangle fixture");
    const element = {
      ...initial.element,
      style: { ...initial.element.style, outlineColor: { type: "theme-text" as const } },
    };
    const record = { ...initial, element };
    const entry = createMountedElement(
      fixture.svg.ownerDocument,
      record,
      buildElementPathParts(element),
      fixture.instrumentation,
    );
    const node = entry.paths[0]!.node;
    fixture.scope.append(node);
    fixture.flush();
    const preview = { ...element, width: 200 };
    updateMountedElementPreview(entry, record, preview, buildElementPathParts(preview), {
      ownerDocument: fixture.svg.ownerDocument,
      parent: fixture.scope,
      instrumentation: fixture.instrumentation,
    });
    fixture.flush();
    expect(readAutoPaintBounds(node)).toEqual({ minX: 99, minY: 9, maxX: 301, maxY: 31 });
    fixture.manager.release();
  });
  it("keeps existing ink and the first image publication atomic across admitted slices", () => {
    const fixture = autoPaintFixture();
    fixture.mount();
    expect(fixture.flush(0)).toBe(true);
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBeNull();
    expect(fixture.images.getAttribute("visibility")).toBe("hidden");
    expect(fixture.flush()).toBe(false);
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBe("");
    expect(fixture.images.getAttribute("visibility")).toBeNull();
    fixture.manager.release();
    expect(fixture.observing()).toBe(false);
    expect(fakeNode(fixture.defs).nodes).toHaveLength(0);
  });

  it("admits a new live point immediately while retained preparation is pending", () => {
    const fixture = autoPaintFixture();
    fixture.mount();
    fixture.flush();
    const live = fixture.mount(30);
    fixture.manager.publishLive(live);
    expect(live.style.getPropertyValue("--inkbook-auto-paint")).toMatch(
      /^url\(#inkbook-scene-auto-/,
    );
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBe("");
    fixture.manager.release();
  });
});

describe("Auto paint during image and selection motion", () => {
  it("derives the screen-space stride from the smallest affine scope scale", () => {
    expect(autoPaintMinimumStride([1, 0, 0, 1, 0, 0], 1)).toBe(32);
    expect(autoPaintMinimumStride([1, 0, 0, 1, 0, 0], 0.01)).toBe(4096);
    expect(autoPaintMinimumStride([0, 0.5, -2, 0, 20, 10], 1)).toBe(64);
  });
  it("retains a fading image-only underlay after the last image is removed", () => {
    const fixture = autoPaintFixture();
    fixture.mount();
    fixture.flush();
    const snapshot = fixture.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
    fixture.root.append(snapshot);
    const release = fixture.manager.retainImage(snapshot);
    fixture.setImages(0);
    fixture.flush();
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBe("");
    release();
    release();
    fixture.flush();
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBeNull();
    fixture.manager.release();
  });

  it("keeps Auto active until the last membership-fading image leaves the actual image band", () => {
    const fixture = autoPaintFixture();
    fixture.mount();
    const image = fixture.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
    fixture.images.append(image);
    fixture.flush();
    fixture.setImages(0);
    fixture.flush();
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBe("");
    image.remove();
    fixture.flush();
    expect(fixture.root.getAttribute("data-inkbook-auto-enabled")).toBeNull();
    fixture.manager.release();
  });

  it("samples world coordinates during an intermediate retained-offset motion frame", () => {
    const fixture = autoPaintFixture();
    const path = fixture.mount(20);
    writeAutoPaintBounds(path, { minX: 0, minY: 0, maxX: 40, maxY: 20 });
    writeMotionStyle(path, 0.5, 0.5, "translate(20px, 0px) ");
    expect(autoPaintTransform(path, fixture.root)).toEqual([0.5, 0, 0, 0.5, 30, 5]);
    expect(inverseAutoPaintTransform(autoPaintTransform(path, fixture.root))).toBe(
      "matrix(2 0 0 2 -60 -10)",
    );
    clearMotionStyle(path);
    expect(autoPaintTransform(path, fixture.root)).toEqual([1, 0, 0, 1, 20, 0]);
    fixture.manager.release();
  });
});
