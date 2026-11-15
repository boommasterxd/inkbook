import { describe, expect, it } from "vitest";
import { autoPaintFixture } from "../../../fixtures/rendering/auto-paint";
import { SceneImageFades } from "../../../../src/rendering/scene/presentation/scene-image-fades";
import { bindImagePaintInstrumentation } from "../../../../src/rendering/scene/content/image-opacity";
import { writeAutoPaintBounds } from "../../../../src/rendering/scene/content/auto-paint-bounds";

describe("shared Auto paint resources", () => {
  it("releases all partly admitted server leases when a large publication is cancelled", () => {
    const fixture = autoPaintFixture();
    for (let index = 0; index < 10_000; index += 1) fixture.mount();
    let clock = 0;
    expect(fixture.flush(8, () => clock++)).toBe(true);
    expect(fixture.paintNodes().some((node) => node.tagName === "pattern")).toBe(true);
    fixture.manager.release();
    expect(fixture.paintNodes()).toHaveLength(0);
    expect(fixture.manager.memoryUsage()).toBe(0);
    expect(fixture.observing()).toBe(false);
  });
  it.each([
    { zoom: 1, xStep: 7, yStep: 3 },
    { zoom: 0.01, xStep: 700, yStep: 300 },
  ])("shares dense and zoomed-out 10,000 tiny clients at zoom $zoom", ({ zoom, xStep, yStep }) => {
    const fixture = autoPaintFixture();
    fixture.setCamera({ x: 0, zoom });
    for (let index = 0; index < 10_000; index += 1) {
      const node = fixture.mount();
      node.setAttribute(
        "transform",
        `translate(${(index % 100) * xStep} ${Math.floor(index / 100) * yStep})`,
      );
      writeAutoPaintBounds(node, { minX: 0, minY: 0, maxX: 8, maxY: 3 });
    }
    fixture.flush();
    const nodes = fixture.paintNodes();
    const aliases = nodes.filter((node) => node.tagName === "pattern" && node.nodes.length === 0);
    const filters = nodes.filter((node) => node.tagName === "filter");
    expect(aliases).toHaveLength(10_000);
    expect(filters.length).toBeLessThanOrEqual(221);
    expect(nodes.filter((node) => node.tagName === "use").length).toBe(filters.length + 3);
    expect(aliases.every((node) => Number(node.attributes.get("width")) === 8)).toBe(true);
    expect(fixture.fake.created).toBeLessThan(23_000);
    fixture.manager.release();
    expect(fixture.paintNodes()).toHaveLength(0);
    expect(fixture.manager.memoryUsage()).toBe(0);
  });
});

describe("bounded Auto paint work", () => {
  it("advances admitted image-opacity work without rebuilding geometry or starting another frame loop", () => {
    const fixture = autoPaintFixture(0);
    const fades = new SceneImageFades();
    let time = 0;
    const now = () => time;
    for (let index = 0; index < 10_000; index += 1) {
      const node = fixture.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
      node.setAttribute("data-inkbook-image", "");
      bindImagePaintInstrumentation(node, fixture.instrumentation);
      fades.apply(node, 150, "opacity", { direction: "enter", generation: 0 }, now);
    }
    fixture.instrumentation.attributeWrites = 0;
    fixture.fake.geometryWrites = 0;
    time = 75;
    fades.advance(75, now);
    expect(fixture.instrumentation.attributeWrites).toBe(1);
    fades.advance(Infinity, now);
    expect(fixture.instrumentation.attributeWrites).toBe(10_000);
    expect(fixture.fake.geometryWrites).toBe(0);
    expect(fades.pending).toBe(true);
    time = 150;
    fades.advance(Infinity, now);
    expect(fades.pending).toBe(false);
    expect(fades.memoryUsage()).toBe(0);
    fades.release();
    fixture.manager.release();
  });
  it("does no DOM work for unchanged 10,000 offset strokes and shares the run movement", () => {
    const fixture = autoPaintFixture();
    for (let index = 0; index < 10_000; index += 1) fixture.mount();
    expect(fixture.flush()).toBe(false);
    const initialBytes = fixture.manager.memoryUsage();
    const initialNodes = fixture.fake.created;
    expect(initialNodes).toBeLessThanOrEqual(2 * 10_000 + 40);
    expect(fixture.paintNodes().filter((node) => node.tagName === "filter")).toHaveLength(2);
    expect(initialBytes).toBeLessThan(25 * 1024 * 1024);
    fixture.fake.reads = 0;
    fixture.fake.writes = 0;
    fixture.fake.geometryWrites = 0;
    fixture.flush();
    expect(fixture.fake.reads).toBe(0);
    expect(fixture.fake.writes).toBe(0);
    fixture.scope.setAttribute("transform", "translate(30 20)");
    fixture.changed(fixture.scope);
    expect(fixture.flush()).toBe(false);
    expect(fixture.fake.writes).toBe(2);
    expect(fixture.fake.reads).toBeLessThan(12);
    expect(fixture.fake.geometryWrites).toBe(0);
    expect(fixture.fake.created).toBe(initialNodes);
    expect(fixture.manager.memoryUsage()).toBe(initialBytes);
    fixture.manager.release();
    expect(fixture.manager.memoryUsage()).toBe(0);
  });

  it("retains no observers, mutation records or patterns for a drawing without images", () => {
    const fixture = autoPaintFixture(0);
    for (let index = 0; index < 10_000; index += 1) fixture.mount();
    fixture.fake.reads = 0;
    fixture.fake.writes = 0;
    fixture.flush();
    fixture.flush();
    expect(fixture.observing()).toBe(false);
    expect(fixture.fake.reads).toBe(0);
    expect(fixture.fake.writes).toBe(0);
    expect(fixture.manager.memoryUsage()).toBe(0);
    fixture.manager.release();
  });
});
