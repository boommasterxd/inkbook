import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildElementPathParts,
  calculateElementBounds,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { scaleElement } from "../../../../src/editor/selection/transforms";
import { rectangle } from "../../../unit/domain/store/fixtures";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { FakeSceneStore, fakeNode, type FakeScheduler } from "../../../unit/rendering/scene/fakes";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";

afterEach(() => vi.restoreAllMocks());

function chargePreviewSteps(scheduler: FakeScheduler) {
  const originalStep = Reflect.get(ProgressivePreviewPath.prototype, "step");
  const steps = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  steps.mockImplementation(function (this: ProgressivePreviewPath, deadline, now) {
    const complete = originalStep.call(this, deadline, now);
    scheduler.time += 1;
    return complete;
  });
  return steps;
}

function setup(pressureEnabled: boolean, includeBox = false) {
  const elements: InkElementV1[] = [indexedStroke(1), indexedStroke(2)].map((element) => ({
    ...element,
    points: Array.from({ length: 4096 }, (_, index) => [
      100 + index * 0.1,
      250 + (index % 2),
      0.5,
    ]).flat(),
    style: { ...element.style, pressureEnabled },
  }));
  if (includeBox) elements.push({ ...rectangle(), rotation: 45 });
  const store = new FakeSceneStore();
  for (const [rank, element] of elements.entries()) {
    store.records.set(element.id, {
      element,
      rank,
      id: element.id,
      band: "content",
      bounds: calculateElementBounds(element),
      geometryVersion: 1,
      paintVersion: 1,
    });
  }
  const { renderer, scheduler } = createSceneFixture(createAllElementSnapshot().page, store);
  scheduler.runAll();
  const nodes = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes;
  const ids = elements.map(({ id }) => id);
  const materialize = vi.fn<(id: string) => InkElementV1 | undefined>();
  let version = 0;
  const request = (scale: number) => {
    const replacements = elements.map((element) =>
      scaleElement(element, { x: 0, y: 0 }, { x: scale, y: 1 }),
    );
    materialize.mockImplementation((id) => replacements.find((element) => element.id === id));
    renderer.setProgressiveElementPreviews(ids, materialize, ++version, {
      transform: `scale(${scale} 1)`,
      inverse: `scale(${1 / scale} 1)`,
    });
    renderer.flushPointerFeedbackFrame();
    return replacements;
  };
  return { renderer, scheduler, nodes, request, materialize };
}

describe("progressive resize pointer feedback", () => {
  it("moves constant-width strokes without rebuilding their centerlines", () => {
    const { renderer, scheduler, nodes, request, materialize } = setup(false);
    const original = nodes.map((node) => node.attributes.get("d"));
    for (const scale of [2, 3, 0.5, 4]) {
      request(scale);
      scheduler.runAll();
      expect(nodes.every((node) => node.attributes.get("transform") === `scale(${scale} 1)`)).toBe(
        true,
      );
      expect(nodes.map((node) => node.attributes.get("d"))).toEqual(original);
      expect(
        nodes.every((node) => node.attributes.get("vector-effect") === "non-scaling-stroke"),
      ).toBe(true);
    }
    expect(materialize).not.toHaveBeenCalled();
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
    expect(nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
    expect(nodes.every((node) => !node.attributes.has("vector-effect"))).toBe(true);
    renderer.destroy();
  });

  it("bridges every pressure resize frame with relative transforms and publishes only complete outlines", () => {
    const { renderer, scheduler, nodes, request, materialize } = setup(true);
    const paths = nodes.map((node) => node.nodes[0]!);
    const original = paths.map((node) => node.attributes.get("d")!);
    const canonicalScales = new Map(original.map((d) => [d, 1]));
    let publications = 0;
    let previous = original;
    let finalGeometry: string[] = [];
    const verify = (scale: number) => {
      for (let index = 0; index < nodes.length; index += 1) {
        const d = paths[index]!.attributes.get("d")!;
        const basis = canonicalScales.get(d);
        expect(basis).toBeDefined();
        expect(paths[index]!.attributes.get("fill-rule")).toBe("nonzero");
        expect(paths[index]!.attributes.has("stroke-width")).toBe(false);
        const inverse = basis === 1 ? "" : ` scale(${1 / basis!} 1)`;
        const transform = scale === basis ? undefined : `scale(${scale} 1)${inverse}`;
        expect(nodes[index]!.attributes.get("transform")).toBe(transform);
        if (d !== previous[index]) publications += 1;
      }
      previous = paths.map((node) => node.attributes.get("d")!);
    };
    for (let frame = 1; frame <= 32; frame += 1) {
      const scale = 1 + frame / 10;
      const replacements = request(scale);
      finalGeometry = replacements.map((element) => buildElementPathParts(element)[0]!.d);
      for (const d of finalGeometry) canonicalScales.set(d, scale);
      verify(scale);
      scheduler.runNext();
      verify(scale);
    }
    scheduler.runAll();
    verify(4.2);
    expect(publications).toBeGreaterThan(2);
    expect(materialize).toHaveBeenCalled();
    expect(paths.map((node) => node.attributes.get("d"))).toEqual(finalGeometry);
    expect(nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
    expect(paths.map((node) => node.attributes.get("d"))).toEqual(original);
    expect(nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
    renderer.destroy();
  });

  it("publishes canonical rotated shapes on every pointer frame beside long pressure strokes", () => {
    const { renderer, scheduler, nodes, request } = setup(true, true);
    const pressurePaths = nodes.slice(0, 2).map((node) => node.nodes[0]!.attributes.get("d"));
    const steps = chargePreviewSteps(scheduler);
    for (const scale of [2, 3, 4]) {
      scheduler.time += 16;
      scheduler.workScheduler.requestFrame(() => {
        const replacements = request(scale);
        expect(nodes[2]!.attributes.get("d")).toBe(buildElementPathParts(replacements[2]!)[0]!.d);
        expect(nodes[2]!.attributes.has("transform")).toBe(false);
        expect(nodes[0]!.attributes.get("transform")).toBe(`scale(${scale} 1)`);
        expect(nodes[1]!.attributes.get("transform")).toBe(`scale(${scale} 1)`);
      }, "input");
      scheduler.runFrame();
      expect(nodes.slice(0, 2).map((node) => node.nodes[0]!.attributes.get("d"))).toEqual(
        pressurePaths,
      );
    }
    expect(steps.mock.calls.length).toBeGreaterThan(4);
    renderer.destroy();
  });

  it("clears feedback before the first snapshot is available", () => {
    const { renderer, scheduler, nodes, request } = setup(true);
    const original = nodes.map((node) => new Map(node.attributes));
    request(2);
    scheduler.runNext();
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
    expect(nodes.map((node) => node.attributes)).toEqual(original);
    renderer.destroy();
  });
});
