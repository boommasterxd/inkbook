import { describe, expect, it } from "vitest";

import { semanticAnchors, type AnchorTargetView } from "../../../../src/domain/geometry/anchors";
import type { Bounds } from "../../../../src/domain/geometry/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
  type SpatialCandidateSink,
  type SnapCandidate,
} from "../../../../src/editor/snapping/snap-candidate";

type TestTarget = AnchorTargetView & { readonly id: string };

function rectangle(id: string): TestTarget {
  return {
    id,
    kind: "rectangle",
    rotation: 0,
    pivot: { x: 50, y: 50 },
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };
}

function harness(targets: readonly TestTarget[], ranks: Readonly<Record<string, number>>) {
  const map = new Map(targets.map((target) => [target.id, target]));
  const scratch = new SnapCandidateScratch();
  return {
    scratch,
    spatial: {
      query: (_bounds: Bounds, sink: SpatialCandidateSink) =>
        targets.forEach((target) => sink.add(target.id)),
    },
    targets: {
      get: (id: string) => {
        const target = map.get(id);
        return target === undefined
          ? null
          : { anchors: semanticAnchors(target), rank: ranks[id] ?? -1 };
      },
    },
  };
}

describe("endpoint snapping", () => {
  it.each([
    { pointerType: "mouse", radius: 12 },
    { pointerType: "pen", radius: 12 },
    { pointerType: "touch", radius: 16 },
  ] as const)(
    "uses the $radius-pixel acquisition boundary for $pointerType",
    ({ pointerType, radius }) => {
      const fixture = harness([rectangle("a")], { a: 0 });
      for (const zoom of [0.5, 2]) {
        for (const [distance, expected] of [
          [radius, "a"],
          [radius + 0.001, undefined],
        ] as const) {
          expect(
            findSnapCandidate(
              { current: null, pointer: { x: 100 + distance / zoom, y: 50 }, pointerType, zoom },
              fixture.spatial,
              fixture.targets,
              fixture.scratch,
            )?.targetId,
          ).toBe(expected);
        }
      }
    },
  );

  it("resolves equal distance by frontmost rank", () => {
    const fixture = harness([rectangle("b"), rectangle("a")], { a: 2, b: 1 });
    const result = findSnapCandidate(
      { current: null, pointer: { x: 100, y: 50 }, pointerType: "mouse", zoom: 1 },
      fixture.spatial,
      fixture.targets,
      fixture.scratch,
    );
    expect(result?.targetId).toBe("a");
  });

  it("retains the current anchor through the four-pixel hysteresis", () => {
    const fixture = harness([rectangle("a")], { a: 0 });
    const current: SnapCandidate = {
      anchor: { kind: "box", position: "middle-right" },
      anchorOrder: 3,
      distancePixels: 0,
      point: { x: 100, y: 50 },
      rank: 0,
      targetId: "a",
    };
    expect(
      findSnapCandidate(
        { current, pointer: { x: 115.9, y: 50 }, pointerType: "mouse", zoom: 1 },
        fixture.spatial,
        fixture.targets,
        fixture.scratch,
      )?.targetId,
    ).toBe("a");
    expect(
      findSnapCandidate(
        { current, pointer: { x: 116.1, y: 50 }, pointerType: "mouse", zoom: 1 },
        fixture.spatial,
        fixture.targets,
        fixture.scratch,
      ),
    ).toBeNull();
  });

  it("queries only the spatial candidate source", () => {
    const fixture = harness([rectangle("a")], { a: 0 });
    let queries = 0;
    const spatial = {
      query: (_bounds: Bounds, _sink: SpatialCandidateSink) => {
        queries += 1;
      },
    };
    const scratch = new SnapCandidateScratch();
    expect(
      findSnapCandidate(
        { current: null, pointer: { x: 100, y: 50 }, pointerType: "touch", zoom: 1 },
        spatial,
        fixture.targets,
        scratch,
      ),
    ).toBeNull();
    expect(queries).toBe(1);
  });
});
