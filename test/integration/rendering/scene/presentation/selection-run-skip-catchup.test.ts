import { afterEach, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { draining } from "../../../../fixtures/rendering/selection-run-drain";
import {
  contentPaths,
  paintedX,
  selectionPath,
} from "../../../../fixtures/rendering/selection-runs";
import { FakeNode, fakeNode } from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

function partialSkip() {
  const f = draining([], 2, true);
  const element = f.selected[550]!;
  const svg = fakeNode(f.renderer.svg);
  const node = selectionPath(f, element);
  const dash = node.getAttribute("stroke-dasharray");
  const expectedD = buildElementPathParts(scaleElement(element, { x: 0, y: 0 }, { x: 2, y: 1 }))[0]!
    .d;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The observation wrapper forwards the actual node through call.
  const insert = FakeNode.prototype.insertBefore;
  const insertion = vi.spyOn(FakeNode.prototype, "insertBefore").mockImplementation(function (
    this: FakeNode,
    child,
    reference,
  ) {
    const result = insert.call(this, child, reference);
    if (child === node) f.scheduler.time += f.scheduler.workScheduler.budgetMs();
    return result;
  });
  f.renderer.setViewport({ left: 0, top: 100_000, width: 2048, height: 1000 });
  for (let frame = 0; node.getAttribute("visibility") !== "hidden"; frame += 1) {
    expect(frame).toBeLessThan(1000);
    f.scheduler.time += 1000 / 120;
    f.scheduler.runFrame();
  }
  insertion.mockRestore();
  expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
  expect(f.scheduler.pendingCount).toBeGreaterThan(0);
  return { ...f, element, node, svg, expectedD, dash };
}

function beginBudgetedReturn(f: ReturnType<typeof partialSkip>): void {
  const camera = f.svg.nodes[1]!;
  const write = camera.setAttribute.bind(camera);
  const cameraWrites = vi.spyOn(camera, "setAttribute").mockImplementation((name, value) => {
    write(name, value);
    if (name === "transform") f.scheduler.time += f.scheduler.workScheduler.budgetMs();
  });
  f.renderer.setCamera({ x: 0, zoom: 2 });
  f.renderer.setViewport({ left: 0, top: 0, width: 2048, height: 1000 });
  f.scheduler.time += 1000 / 120;
  f.scheduler.runFrame();
  expect(cameraWrites.mock.calls.filter(([name]) => name === "transform").length).toBe(1);
  cameraWrites.mockRestore();
}

function expectCanonicalPaint(f: ReturnType<typeof partialSkip>): void {
  const node = contentPaths(f.svg).find((path) => path.getAttribute("d") === f.expectedD)!;
  expect(
    node,
    JSON.stringify({
      expectedD: f.expectedD,
      retainedD: f.node.getAttribute("d"),
      visibility: f.node.getAttribute("visibility"),
      transform: f.node.getAttribute("transform"),
      width: f.node.style.getPropertyValue("stroke-width"),
      mounted: f.renderer.mountedIds("content").includes(f.element.id),
      pending: f.scheduler.pendingCount,
    }),
  ).toBeDefined();
  expect(node.getAttribute("visibility")).not.toBe("hidden");
  expect(node.getAttribute("transform")).toBeNull();
  expect(node.getAttribute("vector-effect")).toBeNull();
  expect(node.style.getPropertyValue("vector-effect")).toBe("");
  expect(node.style.getPropertyValue("stroke-width")).toBe("");
  expect(node.style.getPropertyValue("stroke-dasharray")).toBe("");
  expect(node.getAttribute("stroke-width")).toBe("4");
  expect(node.getAttribute("stroke-dasharray")).toBe(f.dash);
  for (let parent = node.parent; parent !== undefined && parent !== f.svg; parent = parent.parent) {
    expect(parent.getAttribute("data-inkbook-run-active")).toBeNull();
  }
  // Native SVG paint follows camera zoom: width 4 becomes 8 and dash lengths double.
  expect(f.svg.nodes[1]!.getAttribute("transform")).toContain("scale(2)");
  expect(paintedX(node, f.svg.nodes[1]!.nodes[4]!)).toBeCloseTo(
    Number(/^M\s*([-\d.]+)/.exec(f.expectedD)![1]),
    6,
  );
}

it("does not paint a partly skipped old node at stale zoom width before canonical readmission", () => {
  const f = partialSkip();
  try {
    const before = f.writes.filter((id) => id === f.element.id).length;
    const mounts = vi.spyOn(mounted, "createMountedElement");
    beginBudgetedReturn(f);
    expect(f.writes.filter((id) => id === f.element.id).length).toBe(before);
    expect(mounts.mock.calls.filter(([, record]) => record.id === f.element.id).length).toBe(0);
    expect(f.node.getAttribute("visibility")).toBe("hidden");
    f.scheduler.runAll(1000);
    expectCanonicalPaint(f);
    expect(
      f.writes.filter((id) => id === f.element.id).length -
        before +
        mounts.mock.calls.filter(([, record]) => record.id === f.element.id).length,
    ).toBeGreaterThan(0);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("clears skipped compensation and stale geometry when returning after cohort cleanup has ended", () => {
  const f = partialSkip();
  try {
    f.scheduler.runAll(1000);
    expect(f.renderer.mountedCount).toBe(0);
    expect(f.svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    beginBudgetedReturn(f);
    if (contentPaths(f.svg).includes(f.node) && f.node.getAttribute("d") !== f.expectedD)
      expect(f.node.getAttribute("visibility")).toBe("hidden");
    f.scheduler.runAll(1000);
    expectCanonicalPaint(f);
    expect(f.scheduler.pendingCount).toBe(0);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});
