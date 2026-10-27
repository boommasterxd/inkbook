import { expect, vi } from "vitest";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../src/domain/geometry/stroke-position";
import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { scaleElement } from "../../../src/editor/selection/transform/transforms";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import * as mounted from "../../../src/rendering/scene/content/mounted-element";
import { PAGE, rectangle } from "../../unit/domain/store/fixtures";
import { FakeNode, fakeNode } from "../../unit/rendering/scene/fakes";
import { sampleSvgPathContours } from "../domain/svg-path-fill";
import { indexedStroke } from "../editor/stroke";
import { createSceneFixture, sceneDeltaEntries } from "./scene";
import { armSelectionCommit, scaleFeedback, transformSvgPoint } from "./selection-runs";

export const rect = (index: number) => ({
  ...rectangle(indexedStroke(index + 10_000).id, 40, 30),
  width: 10,
  height: 6,
  pivot: { x: 45, y: 33 },
});
export const pressure = (index: number, x = 20) => ({
  ...indexedStroke(index),
  pivot: { x, y: 35 },
  points: [x, 20, 0.5, x, 50, 0.8],
});

export function world(
  elements: InkElementV1[],
  selected = elements,
  initialCount = elements.length,
) {
  const entries = new Map<string, Set<mounted.MountedSceneElement>>();
  const create = mounted.createMountedElement;
  const creations = vi.spyOn(mounted, "createMountedElement").mockImplementation((...args) => {
    const entry = create(...args);
    const known = entries.get(entry.id) ?? new Set();
    known.add(entry);
    entries.set(entry.id, known);
    return entry;
  });
  const store = new ElementStore(elements.slice(0, initialCount)),
    port = new ElementSceneStore(store);
  const scene = createSceneFixture(PAGE, port);
  scene.scheduler.runAll(1000);
  if (initialCount < elements.length) {
    scene.renderer.applyDelta({
      affected: sceneDeltaEntries(store.create(elements.slice(initialCount))!),
    });
    scene.scheduler.runAll(1000);
  }
  const ids = selected.map((element) => element.id),
    selection = new Set(ids);
  scene.renderer.setSelectedElements(selection);
  scene.scheduler.runAll(1000);
  const svg = fakeNode(scene.renderer.svg);
  return {
    ...scene,
    store,
    port,
    entries,
    creations,
    svg,
    selected,
    ids,
    selection,
    materialized: [] as string[],
    pointerWrites: { geometry: 0, transforms: 0 },
    visible(id: string) {
      return [
        ...new Set(
          [...(entries.get(id) ?? [])].flatMap((entry) =>
            entry.paths.map((path) => fakeNode(path.node)),
          ),
        ),
      ].filter((node) => visible(node, svg));
    },
    dispose() {
      scene.renderer.destroy();
      port.release();
      store.releasePreparedPressureGeometry();
      expect(scene.scheduler.pendingCount).toBe(0);
      expect(scene.renderer.mountedCount).toBe(0);
      expect(scene.renderer.memoryUsage().motionCacheBytes).toBe(0);
    },
  };
}

function visible(node: FakeNode, svg: FakeNode): boolean {
  for (let current: FakeNode | undefined = node; current; current = current.parent) {
    for (const key of ["visibility", "display", "opacity", "fill-opacity"]) {
      const value = current.getAttribute(key) ?? current.style.getPropertyValue(key);
      if (
        ["hidden", "collapse", "none"].includes(value) ||
        (["opacity", "fill-opacity"].includes(key) && value !== "" && Number(value) === 0)
      )
        return false;
    }
    if (current === svg) return true;
  }
  return false;
}

export function scale(f: ReturnType<typeof world>, factor: number, version: number) {
  const source = new Map(f.selected.map((element) => [element.id, element]));
  f.materialized.length = 0;
  f.pointerWrites.geometry = 0;
  f.pointerWrites.transforms = 0;
  const writes = vi.spyOn(FakeNode.prototype, "setAttribute");
  const materialize = (id: string) => {
    f.materialized.push(id);
    return scaleElement(source.get(id)!, { x: 0, y: 0 }, { x: factor, y: 1 });
  };
  try {
    f.renderer.setProgressiveElementPreviews(
      f.ids,
      materialize,
      version,
      scaleFeedback(f.selection, factor),
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    f.pointerWrites.geometry = writes.mock.calls.filter(([name]) => name === "d").length;
    f.pointerWrites.transforms = writes.mock.calls.filter(([name]) => name === "transform").length;
  } finally {
    writes.mockRestore();
  }
  f.scheduler.runAll(1000);
  expect(f.scheduler.pendingCount).toBe(0);
  return f.selected.map((element) => scaleElement(element, { x: 0, y: 0 }, { x: factor, y: 1 }));
}

export function assertCanonicalPath(f: ReturnType<typeof world>, element: InkElementV1) {
  const canonical = buildElementPathParts(element);
  const actual = f.visible(element.id);
  expect(actual).toHaveLength(canonical.length);
  for (const [index, part] of canonical.entries()) {
    const expected = sampleSvgPathContours(part.d).flat();
    const observed = points(actual[index]!, f.svg);
    expect(observed).toHaveLength(expected.length);
    expected.forEach((point, pointIndex) => {
      expect(observed[pointIndex]!.x).toBeCloseTo(point.x, 3);
      expect(observed[pointIndex]!.y).toBeCloseTo(point.y, 3);
    });
  }
}

export function commit(f: ReturnType<typeof world>, elements: InkElementV1[]) {
  armSelectionCommit(f);
  const delta = f.store.replaceMany(elements)!;
  f.renderer.applyDelta({ affected: sceneDeltaEntries(delta) });
  return delta;
}

export function points(node: FakeNode, svg: FakeNode) {
  let result = sampleSvgPathContours(node.getAttribute("d")!).flat();
  for (let current: FakeNode | undefined = node; current !== svg; current = current?.parent) {
    expect(current, "Paint remains connected to scene SVG").toBeDefined();
    result = result.map((point) => transformSvgPoint(point, current!.getAttribute("transform")));
  }
  return result;
}

function support(points: readonly PointV1[]) {
  const area =
    Math.abs(
      points.reduce((sum, a, index) => {
        const b = points[(index + 1) % points.length]!;
        return sum + a.x * b.y - b.x * a.y;
      }, 0),
    ) / 2;
  return {
    area,
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

export function assertFill(f: ReturnType<typeof world>, element: InkElementV1) {
  const canonical = buildElementPathParts(
    element.kind === "stroke" ? strokeLocalGeometry(element) : element,
  ).filter((part) => part.paint === "fill");
  const actual = f.visible(element.id).filter((node) => node.getAttribute("fill") !== "none");
  expect(actual).toHaveLength(canonical.length);
  for (const [index, part] of canonical.entries()) {
    const expected = support(
      sampleSvgPathContours(part.d)
        .flat()
        .map((point) =>
          element.kind === "stroke"
            ? transformSvgPoint(
                point,
                `translate(${element.offset?.x ?? 0} ${element.offset?.y ?? 0})`,
              )
            : point,
        ),
    );
    const observed = support(points(actual[index]!, f.svg));
    expect(
      observed.area,
      JSON.stringify({
        id: element.id,
        materialized: f.materialized.indexOf(element.id),
        materializedCount: f.materialized.length,
        expected,
        observed,
        paths: actual.map((node) => {
          const transforms = [];
          for (let parent: FakeNode | undefined = node; parent !== f.svg; parent = parent?.parent)
            transforms.push(parent!.getAttribute("transform"));
          return { d: node.getAttribute("d"), transforms };
        }),
      }),
    ).toBeGreaterThan(0);
    for (const key of ["area", "minX", "maxX", "minY", "maxY"] as const)
      expect(observed[key], key).toBeCloseTo(expected[key], 3);
  }
}

export function assertInvertibleParents(node: FakeNode, svg: FakeNode) {
  for (let parent = node.parent; parent && parent !== svg; parent = parent.parent) {
    for (const match of (parent.getAttribute("transform") ?? "").matchAll(
      /(matrix|scale)\(([^)]*)\)/g,
    )) {
      const n = match[2]!.trim().split(/[ ,]+/).map(Number);
      const determinant =
        match[1] === "scale" ? n[0]! * (n[1] ?? n[0]!) : n[0]! * n[3]! - n[1]! * n[2]!;
      expect(
        Number.isFinite(determinant) && determinant !== 0,
        "Physical grouped parent must remain invertible",
      ).toBe(true);
    }
  }
}
