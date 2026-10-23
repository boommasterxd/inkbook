import { expect, it } from "vitest";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import { containsBounds } from "../../../../src/rendering/scene/visibility/visibility-bounds";

it.each([0.5, 1, 2])("keeps the offscreen mount margins in screen pixels at zoom %s", (zoom) => {
  const viewport = { left: 100, top: 1_000, width: 400, height: 300 };
  const bounds = visibilityPageBounds(viewport, { x: 20, zoom });
  expect(bounds.envelope).toEqual({
    minX: 20 / zoom - 20,
    maxX: 580 / zoom - 20,
    minY: 700 / zoom,
    maxY: 1_600 / zoom,
  });
  expect(bounds.retained).toEqual({
    minX: 60 / zoom - 20,
    maxX: 540 / zoom - 20,
    minY: 800 / zoom,
    maxY: 1_500 / zoom,
  });
  expect(visibilityPageBounds(viewport, { x: 20, zoom }, true)).toEqual({
    envelope: {
      minX: 100 / zoom - 20,
      maxX: 500 / zoom - 20,
      minY: 1_000 / zoom,
      maxY: 1_300 / zoom,
    },
    retained: {
      minX: 100 / zoom - 20,
      maxX: 500 / zoom - 20,
      minY: 1_000 / zoom,
      maxY: 1_300 / zoom,
    },
  });
});

it.each([-1, 1])(
  "refreshes vertical mounting before the leading reserve falls below 200 pixels (%s)",
  (direction) => {
    const viewport = { left: 0, top: 1_000, width: 100, height: 100 };
    const camera = { x: 0, zoom: 1 };
    const { envelope } = visibilityPageBounds(viewport, camera);
    const near = visibilityPageBounds({ ...viewport, top: viewport.top + direction * 100 }, camera);
    const farther = visibilityPageBounds(
      { ...viewport, top: viewport.top + direction * 101 },
      camera,
    );
    expect(containsBounds(envelope, near.retained)).toBe(true);
    expect(containsBounds(envelope, farther.retained)).toBe(false);
  },
);

it.each([100, 300, 800])("derives the reserve from a %s-pixel preload margin", (margin) => {
  const viewport = { left: 0, top: 1_000, width: 100, height: 100 };
  for (const zoom of [0.5, 1, 2]) {
    const { envelope, retained } = visibilityPageBounds(viewport, { x: 0, zoom }, false, margin);
    expect(envelope.minY).toBe((1_000 - margin) / zoom);
    expect(envelope.maxY).toBe((1_100 + margin) / zoom);
    expect(retained.minY).toBe((1_000 - (margin * 2) / 3) / zoom);
    expect(retained.maxY).toBe((1_100 + (margin * 2) / 3) / zoom);
    expect(envelope.minX).toBe(-80 / zoom);
    expect(retained.minX).toBe(-40 / zoom);
    const initial = visibilityPageBounds(viewport, { x: 0, zoom }, true, margin);
    expect(initial.envelope.minY).toBe(1_000 / zoom);
    expect(initial.retained).toEqual(initial.envelope);
  }
});

it.each([-1, 1])("refills the leading margin after one sixth of its reserve (%s)", (sign) => {
  const viewport = { left: 0, top: 1_000, width: 100, height: 100 };
  for (const margin of [100, 300, 800]) {
    for (const zoom of [0.5, 1, 2]) {
      const camera = { x: 0, zoom };
      const direction = { x: 0, y: sign };
      const original = visibilityPageBounds(viewport, camera, false, margin);
      const near = { ...viewport, top: viewport.top + sign * (margin / 6 - 0.01) };
      const far = { ...viewport, top: viewport.top + sign * (margin / 6 + 0.01) };
      const retained = visibilityPageBounds(viewport, camera, false, margin, direction);
      expect(containsBounds(original.envelope, retained.retained)).toBe(true);
      expect(retained.envelope).toEqual(original.envelope);
      expect(
        containsBounds(
          original.envelope,
          visibilityPageBounds(near, camera, false, margin, direction).retained,
        ),
      ).toBe(true);
      expect(
        containsBounds(
          original.envelope,
          visibilityPageBounds(far, camera, false, margin, direction).retained,
        ),
      ).toBe(false);
    }
  }
});

it("keeps neutral and horizontal navigation at the ordinary vertical reserve", () => {
  const viewport = { left: 0, top: 1_000, width: 100, height: 100 };
  const camera = { x: 0, zoom: 1 };
  const original = visibilityPageBounds(viewport, camera);
  for (const direction of [
    { x: 0, y: 0 },
    { x: 1, y: 0.5 },
    { x: -1, y: -0.5 },
  ]) {
    expect(visibilityPageBounds(viewport, camera, false, 300, direction)).toEqual(original);
  }
});
