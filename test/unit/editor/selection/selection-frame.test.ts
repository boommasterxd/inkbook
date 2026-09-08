import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import {
  createSelectionFrameAtRotation,
  SelectionFrameSession,
} from "../../../../src/editor/selection/public";
import { transformSelectionFrame } from "../../../../src/editor/selection/selection-frame";
import { rectangle } from "../../domain/store/fixtures";

function selected(element: InkElementV1) {
  return { bounds: calculateElementBounds(element), element };
}

describe("multi-selection frame session", () => {
  it("retains a committed orientation and restores it through history effects", () => {
    const first = rectangle();
    const second = { ...rectangle("second"), pivot: { x: 600, y: 350 }, x: 500, y: 300 };
    const geometry = [selected(first), selected(second)];
    const changed = vi.fn();
    const session = new SelectionFrameSession(changed);
    const initial = session.current(geometry)!;
    const center = { x: 350, y: 250 };
    const transform = { center, degrees: 30, kind: "rotate" as const };
    const expected = transformSelectionFrame(initial, transform);
    const effect = session.transition(initial, transform)!;

    effect.apply();
    expect(session.current(geometry)).toEqual(expected);
    expect(session.current(geometry)?.rotation).toBe(30);

    effect.revert();
    expect(session.current(geometry)).toEqual(initial);

    effect.apply();
    expect(session.current(geometry)?.points).toEqual(expected.points);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("ignores stale history effects after a semantic selection reset", () => {
    const geometry = [selected(rectangle()), selected(rectangle("second"))];
    const session = new SelectionFrameSession();
    const initial = session.current(geometry)!;
    const effect = session.transition(initial, {
      center: { x: 200, y: 150 },
      degrees: 45,
      kind: "rotate",
    })!;

    session.reset();
    const replacement = session.current(geometry);
    effect.apply();

    expect(session.current(geometry)).toBe(replacement);
    expect(session.current(geometry)?.rotation).toBe(0);
  });
});

describe("multi-selection frame geometry", () => {
  it("keeps move and uniform resize algebraic without changing frame rotation", () => {
    const geometry = [selected(rectangle()), selected(rectangle("second"))];
    const session = new SelectionFrameSession();
    const initial = session.current(geometry)!;
    const rotated = transformSelectionFrame(initial, {
      center: { x: 200, y: 150 },
      degrees: 30,
      kind: "rotate",
    });
    const moved = transformSelectionFrame(rotated, {
      delta: { x: 25, y: 40 },
      kind: "translate",
    });
    const scaled = transformSelectionFrame(moved, {
      anchor: moved.points[0],
      delta: { x: 0, y: 0 },
      factors: { x: 1.5, y: 1.5 },
      kind: "scale",
      rotation: moved.rotation,
    });

    expect(moved.rotation).toBe(30);
    expect(scaled.rotation).toBe(30);
    expect(moved.points[0]).toEqual({
      x: rotated.points[0].x + 25,
      y: rotated.points[0].y + 40,
    });
  });

  it("rebases coarse geometry changes without losing orientation and restores them on undo", () => {
    const first = rectangle();
    const second = rectangle("second", 500, 300);
    const geometry = [selected(first), selected(second)];
    const session = new SelectionFrameSession();
    const initial = session.current(geometry)!;
    const rotated = transformSelectionFrame(initial, {
      center: { x: 400, y: 250 },
      degrees: 30,
      kind: "rotate",
    });
    session
      .transition(initial, {
        center: { x: 400, y: 250 },
        degrees: 30,
        kind: "rotate",
      })
      ?.apply();
    const widened = { ...second, pivot: { x: 675, y: 350 }, width: 350 };
    const expected = createSelectionFrameAtRotation([first, widened], rotated.rotation);
    const effect = session.rebase(rotated, [first, widened]);
    if (expected === null || effect === undefined) throw new TypeError("Expected a frame rebase.");

    effect.apply();
    const applied = session.current(geometry);
    expect(applied?.points).toEqual(expected.points);
    expect(applied?.rotation).toBe(rotated.rotation);
    effect.revert();
    expect(session.current(geometry)).toEqual(rotated);
  });
});
