import { expect, vi } from "vitest";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneViewport } from "../../../src/rendering/scene/types";
import type { FakeNode, FakeScheduler } from "../../unit/rendering/scene/fakes";

/** Begins one observed viewport frame with counters local to its publication. */
export function beginViewportPublication(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  viewport: SceneViewport,
) {
  renderer.resetInstrumentation();
  renderer.setViewport(viewport);
  scheduler.runNext();
  return renderer.instrumentation();
}

/** Observes each real scene publication, preserving its per-frame root resource cap. */
export function flushBoundedScenePublication(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  observe?: () => void,
): void {
  let previous = renderer.mountedCount;
  let frames = 0;
  while (scheduler.pendingCount > 0) {
    if (frames++ >= 100) throw new Error("Frame limit exceeded.");
    scheduler.runNext();
    expect(renderer.mountedCount - previous).toBeLessThanOrEqual(64);
    previous = renderer.mountedCount;
    observe?.();
  }
}

/** Makes subsequent work yield only after an actual DOM publication starts. */
export function chargeClockAfterPublication(content: FakeNode, scheduler: FakeScheduler) {
  let publicationStarted = false;
  const originalInsert = content.insertBefore.bind(content);
  const insert = vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
    const result = originalInsert(node, successor);
    publicationStarted = true;
    return result;
  });
  const now = vi
    .spyOn(scheduler, "now")
    .mockImplementation(() => (publicationStarted ? (scheduler.time += 8) : scheduler.time));
  return () => {
    now.mockRestore();
    insert.mockRestore();
  };
}
