import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { moveSelection } from "../../../../src/editor/selection/public";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../../interaction-refresh-profile";
import { timingBudget } from "../../timing-budget";
import {
  INTERACTION_ELEMENT_COUNT,
  INTERACTION_PAGE,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz renderer reconciliation profile`, () => {
  it("keeps coalesced pan, zoom, and viewport jumps within budget", async ({ annotate }) => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    renderer.setPage(INTERACTION_PAGE, 2_000);
    scheduler.runAll();
    renderer.resetInstrumentation();

    const durations = measureInteractionFrames((frame) => {
      const phase = frame % 4;
      renderer.setViewport({
        height: 100,
        left: 0,
        top: phase < 2 ? 0 : 800,
        width: 100,
      });
      renderer.setCamera({ x: phase % 2 === 0 ? 0 : -50, zoom: phase % 3 === 0 ? 1.05 : 1 });
      scheduler.runAll();
    });

    const p99 = interactionP99(durations);
    const instrumentation = renderer.instrumentation();
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    expect(instrumentation.spatialQueries).toBeGreaterThan(0);
    expect(instrumentation.domEntrants).toBeGreaterThan(0);
    expect(instrumentation.domExits).toBeGreaterThan(0);
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    await annotate(
      interactionProfileAnnotation("pan, zoom, and viewport reconciliation", p99),
      "performance",
    );
    renderer.destroy();
  });

  it("keeps preview-to-single-element commit handoff within budget", async ({ annotate }) => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    scheduler.runAll();
    const id = fixture.ids[0]!;
    let publishedDeltas = 0;
    const unsubscribe = fixture.store.subscribe((delta) => {
      publishedDeltas += 1;
      renderer.applyDelta({
        affected: delta.changes.map((change) => ({
          after: recordElement(change.after),
          before: recordElement(change.before),
          domains: change.domains,
          id: change.id,
        })),
      });
    });

    let failedHandoffs = 0;
    let failedReplacements = 0;
    const durations = measureInteractionFrames((frame) => {
      const distance = frame % 2 === 0 ? 0.01 : -0.01;
      renderer.setPreviewTransform([id], `translate(${String(distance)} 0)`, frame + 1);
      scheduler.runAll();
      const handoff = renderer.beginPreviewCommit();
      renderer.clearPreviewTransforms();
      if (!handoff.arm([id])) failedHandoffs += 1;
      const current = fixture.store.get(id)?.element as InkElementV1 | undefined;
      if (current === undefined) throw new Error("The commit fixture element is unavailable.");
      const replacement = moveSelection([current], { x: distance, y: 0 })[0]!;
      if (fixture.store.replace(id, replacement) === null) failedReplacements += 1;
      scheduler.runAll();
    });

    const p99 = interactionP99(durations);
    expect(failedHandoffs).toBe(0);
    expect(failedReplacements).toBe(0);
    expect(publishedDeltas).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("preview-to-commit handoff", p99), "performance");
    unsubscribe();
    renderer.destroy();
  });
});

function recordElement(record: { readonly element: unknown } | null): InkElementV1 | null {
  return record === null ? null : (record.element as InkElementV1);
}
