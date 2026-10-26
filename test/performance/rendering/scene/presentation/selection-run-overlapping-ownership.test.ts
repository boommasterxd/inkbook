import { afterEach, expect, it, vi } from "vitest";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { CommittedPreviewGeometry } from "../../../../../src/rendering/scene/presentation/committed-preview-geometry";
import { SelectionRunResiduals } from "../../../../../src/rendering/scene/presentation/selection-run-residuals";
import { draining, expectCanonical } from "../../../../fixtures/rendering/selection-run-drain";
import {
  commitSelectionMove,
  expectSelectionStart,
  fixtureElement,
} from "../../../../fixtures/rendering/selection-runs";
import { FakeNode } from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

it("bounds known-matrix feedback ownership across overlapping Move commits before the next scene frame", () => {
  const f = draining();
  try {
    const residualMemory = vi.spyOn(SelectionRunResiduals.prototype, "memoryUsage");
    const committedMemory = vi.spyOn(CommittedPreviewGeometry.prototype, "memoryUsage");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The observation wrapper forwards the actual node through call.
    const insertAttribute = FakeNode.prototype.setAttribute;
    let maxTransformLength = 0;
    let transformWrites = 0;
    vi.spyOn(FakeNode.prototype, "setAttribute").mockImplementation(function (
      this: FakeNode,
      name,
      value,
    ) {
      if (name === "transform") {
        maxTransformLength = Math.max(maxTransformLength, value.length);
        transformWrites += 1;
      }
      insertAttribute.call(this, name, value);
    });
    const subset = [f.pens[0]!, f.ids[f.ids.length - 1]!];
    let plateau = 0;
    let wholePlateau = 0;
    for (let generation = 1; generation <= 18; generation += 1) {
      const ids = generation % 2 === 1 ? f.ids : subset;
      const moved = moveSelection(
        ids.map((id) => fixtureElement(f, id)),
        { x: 1, y: 0 },
      );
      f.renderer.setSelectedElements(new Set(ids));
      f.renderer.setPreviewTransform(
        ids,
        "translate(1 0)",
        generation + 1,
        "scale",
        undefined,
        [1, 0, 0, 1, 1, 0],
      );
      f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
      commitSelectionMove(f, ids, moved);
      const wholeBytes = f.renderer.memoryUsage().pathCacheBytes;
      const bytes =
        Number(residualMemory.mock.results[residualMemory.mock.results.length - 1]!.value) +
        Number(committedMemory.mock.results[committedMemory.mock.results.length - 1]!.value);
      expect(Number.isFinite(bytes)).toBe(true);
      if (generation === 2) {
        plateau = bytes;
        wholePlateau = wholeBytes;
      }
      // Up to three serialized six-coefficient matrices, each growing by one UTF-16 digit.
      if (generation > 2)
        expect(bytes, `generation ${generation}, total estimate ${wholeBytes}`).toBeLessThanOrEqual(
          plateau + f.ids.length * 3 * 6 * 2,
        );
      expect(maxTransformLength).toBeLessThan(256);
    }
    expect(transformWrites).toBeGreaterThan(0);
    f.scheduler.runAll(1000);
    expectCanonical(f);
    const last = fixtureElement(f, subset[1]!);
    expectSelectionStart(f, last);
    f.renderer.destroy();
    expect(f.scheduler.pendingCount).toBe(0);
    expect(f.renderer.memoryUsage().pathCacheBytes).toBeLessThan(wholePlateau);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});
