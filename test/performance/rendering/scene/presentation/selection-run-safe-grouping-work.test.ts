import { afterEach, expect, it, vi } from "vitest";
import {
  assertFill,
  assertInvertibleParents,
  pressure,
  rect,
  scale,
  world,
} from "../../../../fixtures/rendering/selection-run-world";

afterEach(() => vi.restoreAllMocks());

it("retains the profitable 9,995-shape group in a 20,000-element scene with two physical pressure exceptions", () => {
  const a = pressure(0),
    b = pressure(1, 30);
  const shapes = Array.from({ length: 9_995 }, (_, index) => rect(index));
  const elements = [
    a,
    rect(10_000),
    b,
    rect(10_001),
    ...shapes,
    ...Array.from({ length: 10_001 }, (_, index) => rect(index + 10_002)),
  ];
  const f = world(elements, [a, b, ...shapes]);
  try {
    expect(elements).toHaveLength(20_000);
    expect(f.svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBeNull();
    scale(f, 2, 1);
    // Existing snapshot budget256 plus bounded shared group/trace surfaces.
    // Observes actual SVG writes during the public pointer-feedback flush.
    expect(f.pointerWrites.transforms).toBeLessThanOrEqual(260);
    expect(f.pointerWrites.geometry).toBeLessThanOrEqual(256);
    const changed = scale(f, 0, 2);
    assertFill(f, changed[0]!);
    assertFill(f, changed[1]!);
    assertInvertibleParents(f.visible(shapes[9_994]!.id)[0]!, f.svg);
    expect(f.renderer.memoryUsage().pathCacheBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    f.renderer.clearPreviewTransforms();
    f.renderer.clearElementPreviews();
    f.scheduler.runAll(1000);
    assertFill(f, a);
    assertFill(f, b);
    expect(f.scheduler.pendingCount).toBe(0);
  } finally {
    f.dispose();
  }
});
