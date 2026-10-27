import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import {
  armSelectionCommit,
  contentPaths,
  fixture,
  startSelectionResize,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";
function active() {
  const f = fixture();
  startSelectionResize(f);
  const last = f.selected[f.selected.length - 1]!,
    node = contentPaths(fakeNode(f.renderer.svg)).find(
      (path) => path.getAttribute("d") === buildElementPathParts(last)[0]!.d,
    )!;
  return {
    ...f,
    last,
    node,
    band: fakeNode(f.renderer.svg).nodes[1]!.nodes[4]!,
  };
}
it("canonical pressure exceptions receive geometry admission before a whole large run finishes", () => {
  const f = active();
  let spy: import("vitest").MockInstance<typeof mounted.updateMountedGeometry> | undefined;
  try {
    f.factor.value = 3;
    f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 2, {
      ...f.feedback,
      transform: "scale(3 1)",
      inverse: `scale(${1 / 3} 1)`,
      matrix: [3, 0, 0, 1, 0, 0],
    });
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    const replaced = f.selected.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 3, y: 1 }));
    armSelectionCommit(f);
    const original = mounted.updateMountedGeometry;
    const writes: string[] = [];
    spy = vi.spyOn(mounted, "updateMountedGeometry").mockImplementation((...args) => {
      writes.push(args[0].id);
      original(...args);
      f.scheduler.time += 1;
    });
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(replaced)!),
    });
    f.scheduler.runFrame();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((id) => f.pens.includes(id))).toBe(true);
  } finally {
    spy?.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});
