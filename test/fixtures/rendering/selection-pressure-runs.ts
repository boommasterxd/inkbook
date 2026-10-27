import { expect, vi } from "vitest";
import {
  buildElementPathParts,
  buildLinearPathParts,
} from "../../../src/domain/geometry/element-path";
import { roundCanonical } from "../../../src/domain/geometry/primitives";
import { strokeLocalGeometry } from "../../../src/domain/geometry/stroke-position";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { scaleElement } from "../../../src/editor/selection/transform/transforms";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import * as mounted from "../../../src/rendering/scene/content/mounted-element";
import {
  coordinateSystem,
  PAGE,
  rectangle,
  tableFromRectangle,
} from "../../unit/domain/store/fixtures";
import { fakeNode, type FakeNode } from "../../unit/rendering/scene/fakes";
import { indexedStroke } from "../editor/stroke";
import { createSceneFixture } from "./scene";

type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function parse(value: string | null): Matrix {
  let result = identity;
  for (const match of (value ?? "").matchAll(/(matrix|translate|scale|rotate)\(([^)]*)\)/g)) {
    const n = match[2]!.trim().split(/[ ,]+/).map(Number);
    let next: Matrix;
    if (match[1] === "matrix") next = n as Matrix;
    else if (match[1] === "translate") next = [1, 0, 0, 1, n[0]!, n[1] ?? 0];
    else if (match[1] === "scale") next = [n[0]!, 0, 0, n[1] ?? n[0]!, 0, 0];
    else {
      const angle = (n[0]! * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle);
      next = [c, s, -s, c, 0, 0];
      if (n.length === 3)
        next = multiply(multiply([1, 0, 0, 1, n[1]!, n[2]!], next), [1, 0, 0, 1, -n[1]!, -n[2]!]);
    }
    result = multiply(result, next);
  }
  return result;
}
export function world(node: FakeNode, stop: FakeNode): Matrix {
  let result = identity;
  for (let current: FakeNode | undefined = node; current !== stop; current = current?.parent) {
    expect(current, "painted node must remain attached to its band").toBeDefined();
    result = multiply(parse(current!.getAttribute("transform")), result);
  }
  return result;
}
export function matrixEqual(actual: Matrix, expected: readonly number[]) {
  actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i]!, 8));
}
export function paths(root: FakeNode): FakeNode[] {
  return root.tagName === "path" ? [root] : root.nodes.flatMap(paths);
}
export function fixture(count = 600, extra: InkElementV1[] = [], dense = false) {
  const entries = new Map<string, mounted.MountedSceneElement>();
  const original = mounted.createMountedElement;
  const capture = vi.spyOn(mounted, "createMountedElement").mockImplementation((...args) => {
    const e = original(...args);
    // These scenarios retain their original mounted entries. Temporary singular
    // paint entries share the logical ID and must not replace this scene observer.
    if (!entries.has(e.id)) entries.set(e.id, e);
    return e;
  });
  const elements: InkElementV1[] = Array.from({ length: count }, (_, i) => ({
    ...indexedStroke(i),
    points: [
      roundCanonical(20 + i / 1000),
      20,
      0.2,
      roundCanonical(23 + i / 1000),
      22,
      0.85,
      roundCanonical(26 + i / 1000),
      20,
      0.4,
    ],
    pivot: { x: roundCanonical(23 + i / 1000), y: 21 },
  }));
  if (dense) {
    const pen = elements[0]!;
    if (pen.kind !== "stroke") throw new Error("Pressure fixture requires a stroke.");
    elements[0] = {
      ...pen,
      style: { ...pen.style, opacity: 0.4 },
      points: Array.from({ length: 384 }, (_, index) => [
        roundCanonical(20 + index / 4),
        roundCanonical(30 + Math.sin(index / 3) * 8),
        roundCanonical(0.2 + (index % 7) / 10, 4),
      ]).flat(),
    };
  }
  elements.push(...extra);
  const store = new ElementStore(elements),
    port = new ElementSceneStore(store),
    f = createSceneFixture(PAGE, port);
  f.scheduler.runAll();
  const selection = new Set(elements.map((e) => e.id)),
    ids = [...selection];
  f.renderer.setSelectedElements(selection);
  f.scheduler.runAll();
  const svg = fakeNode(f.renderer.svg),
    camera = svg.nodes[1]!,
    ink = camera.nodes[4]!,
    traces = camera.nodes[8]!;
  return {
    ...f,
    entries,
    elements,
    store,
    port,
    selection,
    ids,
    svg,
    ink,
    traces,
    dispose() {
      f.renderer.destroy();
      port.release();
      capture.mockRestore();
    },
  };
}
function feedback(f: ReturnType<typeof fixture>, x: number, y = 1) {
  return {
    selection: f.selection,
    selectionSize: f.ids.length,
    invertible: x !== 0 && y !== 0,
    matrix: [x, 0, 0, y, 0, 0] as const,
    transform: `scale(${x} ${y})`,
    inverse: x !== 0 && y !== 0 ? `scale(${1 / x} ${1 / y})` : "",
  };
}
export function start(f: ReturnType<typeof fixture>, x: number, version = 1, y = 1) {
  const byId = new Map(f.elements.map((e) => [e.id, e]));
  const materialize = vi.fn((id: string) => scaleElement(byId.get(id)!, { x: 0, y: 0 }, { x, y }));
  f.renderer.setProgressiveElementPreviews(f.ids, materialize, version, feedback(f, x, y));
  f.renderer.flushPointerFeedbackFrame(0);
  return materialize;
}
export function assertGeometry(f: ReturnType<typeof fixture>, elements: InkElementV1[]) {
  const traces = new Map(
    paths(f.traces).map((node) => [node.getAttribute("data-selection-element-id"), node]),
  );
  for (const e of elements) {
    const entry = f.entries.get(e.id)!;
    expect(entry).toBeDefined();
    expect(f.svg.contains(fakeNode(entry.paths[0]!.node))).toBe(true);
    const expected = buildElementPathParts(e.kind === "stroke" ? strokeLocalGeometry(e) : e);
    expect(entry.paths.map((p) => fakeNode(p.node).getAttribute("d"))).toEqual(
      expected.map((p) => p.d),
    );
    const trace = traces.get(e.id)!;
    expect(trace).toBeDefined();
    const center =
      e.kind === "stroke" && e.style.pressureEnabled
        ? buildElementPathParts({
            ...strokeLocalGeometry(e),
            style: { ...e.style, pressureEnabled: false },
          })
        : e.kind === "arrow"
          ? buildLinearPathParts(e, "centerline")
          : expected;
    expect(trace.getAttribute("d")).toBe(center.map((part) => part.d).join(""));
    matrixEqual(world(fakeNode(entry.paths[0]!.node), f.ink), world(trace, f.traces));
  }
}

export function compoundPressureElements(index: number) {
  const box = rectangle(indexedStroke(index).id, 35, 35);
  const table = { ...tableFromRectangle(box), id: indexedStroke(index + 1).id };
  const coordinate = { ...coordinateSystem(), id: indexedStroke(index + 2).id };
  const arrow: InkElementV1 = {
    id: indexedStroke(index + 3).id,
    kind: "arrow",
    createdAt: 0,
    start: { x: 15, y: 15 },
    end: { x: 45, y: 35 },
    bend: null,
    pivot: { x: 30, y: 25 },
    rotation: 0,
    startConnection: null,
    endConnection: null,
    startNode: "triangle",
    endNode: "diamond",
    style: coordinate.style,
  };
  return { table, coordinate, arrow };
}
