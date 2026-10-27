import { expect, vi } from "vitest";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { scaleElement } from "../../../src/editor/selection/transform/transforms";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { PAGE, rectangle } from "../../unit/domain/store/fixtures";
import { FakeNode, fakeNode } from "../../unit/rendering/scene/fakes";
import { indexedStroke } from "../editor/stroke";
import { createSceneFixture, sceneDeltaEntries } from "./scene";

export function fixture(
  count = 600,
  dashed = false,
  prepareSelection = true,
  additional: readonly InkElementV1[] = [],
  frameBudgetMs = 8,
) {
  const a = { ...indexedStroke(0), points: [20, 20, 0.5, 23, 22, 0.8] },
    b = { ...indexedStroke(1), points: [30, 20, 0.5, 33, 22, 0.8] };
  const objects = Array.from({ length: count }, (_, i) => {
    const shape = {
      ...rectangle(indexedStroke(1000 + i).id, 40 + i / 1000, 30),
      width: 10,
      height: 6,
      pivot: { x: 45 + i / 1000, y: 33 },
    };
    return dashed
      ? {
          ...shape,
          style: {
            ...shape.style,
            outlineWidth: 4 as const,
            outlineStyle: "dashed" as const,
          },
        }
      : shape;
  });
  const elements = [
    a,
    rectangle(indexedStroke(90000).id, 25, 25),
    b,
    rectangle(indexedStroke(90001).id, 35, 25),
    ...objects,
    ...additional,
  ];
  const selected = [a, b, ...objects],
    ids = selected.map((e) => e.id),
    selection = new Set(ids),
    store = new ElementStore(elements),
    port = new ElementSceneStore(store);
  const scene = createSceneFixture(PAGE, port, undefined, { frameBudgetMs });
  scene.scheduler.runAll();
  if (prepareSelection) {
    scene.renderer.setSelectedElements(selection);
    scene.scheduler.runAll();
  }
  const factor = { value: 2 };
  const materialize = vi.fn((id: string) => {
    const e = selected.find((e) => e.id === id);
    return e === undefined ? undefined : scaleElement(e, { x: 0, y: 0 }, { x: factor.value, y: 1 });
  });
  const feedback = {
    selection,
    selectionSize: ids.length,
    invertible: true,
    matrix: [2, 0, 0, 1, 0, 0] as const,
    transform: "scale(2 1)",
    inverse: "scale(0.5 1)",
  };
  return {
    ...scene,
    store,
    port,
    elements,
    selected,
    ids,
    selection,
    feedback,
    materialize,
    factor,
    pens: [a.id, b.id],
  };
}

export function contentPaths(svg: ReturnType<typeof fakeNode>) {
  const content = svg.nodes[1]!.nodes[4]!;
  const visit = (node: typeof svg): (typeof svg)[] =>
    node.tagName === "path" ? [node] : node.nodes.flatMap(visit);
  return visit(content);
}

/** Borrow validated fixture records for helpers that only read canonical DTOs. */
export function fixtureElement(f: ReturnType<typeof fixture>, id: string): InkElementV1 {
  return f.store.get(id)!.element as InkElementV1;
}

/** Evaluates the painted first point through the actual retained SVG parents. */
export function paintedX(node: ReturnType<typeof fakeNode>, band: typeof node): number {
  const match = /^M\s*([-\d.]+)[ ,]([-\d.]+)/.exec(node.getAttribute("d")!)!;
  let x = Number(match[1]),
    y = Number(match[2]);
  for (let current: typeof node | undefined = node; current !== band; current = current?.parent) {
    expect(current).toBeDefined();
    ({ x, y } = transformSvgPoint({ x, y }, current!.getAttribute("transform")));
  }
  return x;
}

/** Arms the public preview handoff before a real committed Store mutation. */
export function armSelectionCommit(f: Pick<ReturnType<typeof fixture>, "renderer" | "ids">): void {
  const handoff = f.renderer.beginPreviewCommit();
  expect(handoff.arm(f.ids)).toBe(true);
  f.renderer.clearProgressiveElementPreviews();
}

/** Starts the standard resize and drains only its owned coalesced preparation frames. */
export function startSelectionResize(f: ReturnType<typeof fixture>): void {
  f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 1, f.feedback);
  f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
  f.scheduler.runAll();
}

/** Publishes a real Move commit with its existing suppression and preview cleanup. */
export function commitSelectionMove(
  f: Pick<ReturnType<typeof fixture>, "renderer" | "store">,
  ids: readonly string[],
  elements: readonly InkElementV1[],
): void {
  f.renderer.suppressMotionForNextDelta(ids);
  f.renderer.applyDelta({
    affected: sceneDeltaEntries(f.store.replaceMany(elements)!),
  });
  f.renderer.clearPreviewTransforms();
}

/** Commits the fixture's selected scale through the armed renderer handoff. */
export function commitSelectionScale(
  f: ReturnType<typeof fixture>,
  factor: number,
): InkElementV1[] {
  armSelectionCommit(f);
  const scaled = f.selected.map((element) =>
    scaleElement(element, { x: 0, y: 0 }, { x: factor, y: 1 }),
  );
  f.renderer.applyDelta({
    affected: sceneDeltaEntries(f.store.replaceMany(scaled)!),
  });
  return scaled;
}

/** Captures member-root reparenting at the real DOM insertion boundary. */
export function observeSelectionInsertions(
  members: ReadonlySet<import("../../unit/rendering/scene/fakes").FakeNode>,
) {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the observed DOM node as receiver.
  const original = FakeNode.prototype.insertBefore;
  vi.spyOn(FakeNode.prototype, "insertBefore").mockImplementation(function (
    this: FakeNode,
    node,
    reference,
  ) {
    if (members.has(node)) calls.push(node.tagName);
    return original.call(this, node, reference);
  });
  return calls;
}

/** Resolves the existing visible canonical path used for immediate transform checks. */
export function selectionPath(
  f: Pick<ReturnType<typeof fixture>, "renderer">,
  element: InkElementV1,
) {
  const path = buildElementPathParts(element)[0]!.d;
  const node = contentPaths(fakeNode(f.renderer.svg)).find(
    (entry) => entry.getAttribute("d") === path,
  );
  expect(node).toBeDefined();
  return node!;
}

export function transformSvgPoint(point: PointV1, expression: string | null): PointV1 {
  let { x, y } = point;
  for (const match of [
    ...(expression ?? "").matchAll(/(matrix|translate|scale)\(([^)]*)\)/g),
  ].reverse()) {
    const n = match[2]!.trim().split(/[ ,]+/).map(Number);
    if (match[1] === "scale") {
      x *= n[0]!;
      y *= n[1] ?? n[0]!;
    } else if (match[1] === "translate") {
      x += n[0]!;
      y += n[1] ?? 0;
    } else {
      const nextX = n[0]! * x + n[2]! * y + n[4]!;
      y = n[1]! * x + n[3]! * y + n[5]!;
      x = nextX;
    }
  }
  return { x, y };
}

/** Keeps public feedback matrices consistent across the owned scene fixtures. */
export function scaleFeedback(selection: ReadonlySet<string>, factor: number) {
  return {
    selection,
    selectionSize: selection.size,
    invertible: factor !== 0,
    matrix: [factor, 0, 0, 1, 0, 0] as const,
    transform: `scale(${factor} 1)`,
    inverse: factor === 0 ? "" : `scale(${1 / factor} 1)`,
  };
}

export function moveFeedback(selection: ReadonlySet<string>, x: number, y: number) {
  return {
    selection,
    selectionSize: selection.size,
    invertible: true,
    matrix: [1, 0, 0, 1, x, y] as const,
    transform: `translate(${x} ${y})`,
    inverse: `translate(${-x} ${-y})`,
  };
}

/** Checks canonical first-point placement after normalization and residual cleanup. */
export function expectSelectionStart(
  f: Pick<ReturnType<typeof fixture>, "renderer">,
  element: InkElementV1,
) {
  const expectedD = buildElementPathParts(element)[0]!.d;
  const target = selectionPath(f, element);
  const band = fakeNode(f.renderer.svg).nodes[1]!.nodes[4]!;
  expect(paintedX(target, band)).toBeCloseTo(Number(/^M\s*([-\d.]+)/.exec(expectedD)![1]), 6);
}

export function applySelectionDelta(
  f: Pick<ReturnType<typeof fixture>, "renderer" | "store" | "ids">,
  elements: readonly InkElementV1[],
) {
  f.renderer.suppressMotionForNextDelta(f.ids);
  f.renderer.applyDelta({
    affected: sceneDeltaEntries(f.store.replaceMany(elements)!),
  });
}
