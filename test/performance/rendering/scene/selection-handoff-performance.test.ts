import { describe, expect, it } from "vitest";

import type { InkElementV1, PageV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../../src/editor/selection/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  FakeDocument,
  FakeNode,
  FakeScheduler,
  asElement,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";
import { MeasuredSliceScheduler } from "../../domain/domain-scenarios";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import { timingBudget } from "../../timing-budget";

const ELEMENT_COUNT = 10_000;
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};

describe("selection preview handoff performance", () => {
  it("keeps the real 10,000-element renderer subscriber inside its frame slice", async ({
    annotate,
  }) => {
    const elements = Array.from({ length: ELEMENT_COUNT }, (_, index) => indexedStroke(index));
    const ids = elements.map(({ id }) => id);
    const store = new ElementStore(elements);
    const scheduler = new FakeScheduler();
    const renderer = new SvgSceneRenderer({
      container: asElement(new FakeNode(new FakeDocument(), "div")),
      layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
      page: PAGE,
      scheduler,
      store: new ElementSceneStore(store),
    });
    renderer.setPage(PAGE, 200_000);
    scheduler.runAll();
    const subscriberDurations: number[] = [];
    let subscriberDuration = 0;
    const unsubscribe = store.subscribe((delta) => {
      const startedAt = performance.now();
      const affected = [];
      for (const change of delta.changes) {
        affected.push({
          id: change.id,
          domains: change.domains,
          before: recordElement(change.before),
          after: recordElement(change.after),
        });
      }
      renderer.applyDelta({ affected });
      subscriberDuration = performance.now() - startedAt;
    });
    const commitDurations: number[] = [];

    for (let run = 0; run < 6; run += 1) {
      const current = ids.map((id) => store.get(id)?.element as InkElementV1);
      const distance = run % 2 === 0 ? 0.001 : -0.001;
      const preparationScheduler = new MeasuredSliceScheduler(2);
      const replacements = await moveSelectionTimeSliced(
        current,
        { x: distance, y: distance },
        preparationScheduler,
      );
      if (replacements === null) throw new Error("Selection materialization was cancelled.");
      const prepared = await store.prepareElementReplacement(replacements, preparationScheduler);
      if (prepared.status !== "prepared" || prepared.token === null) {
        throw new Error("Selection replacement was not prepared.");
      }

      renderer.setPreviewTransform(
        ids,
        `translate(${String(distance)} ${String(distance)})`,
        run + 1,
      );
      scheduler.runAll();
      const handoff = renderer.beginPreviewCommit();
      renderer.clearPreviewTransforms();
      expect(handoff.arm(ids)).toBe(true);
      renderer.resetInstrumentation();
      const startedAt = performance.now();
      const result = store.commitPreparedElementReplacement(prepared.token);
      const commitDuration = performance.now() - startedAt;
      expect(result.status).toBe("committed");
      expect(result.delta?.changes).toHaveLength(ELEMENT_COUNT);
      expect(renderer.instrumentation().motionGeometryTransitions).toBe(0);
      scheduler.runAll();
      expect(transformedContentCount(renderer)).toBe(0);
      if (run > 0) {
        subscriberDurations.push(subscriberDuration);
        commitDurations.push(commitDuration);
      }
    }

    unsubscribe();
    renderer.destroy();
    const maximumSubscriberDuration = Math.max(...subscriberDurations);
    const maximumCommitDuration = Math.max(...commitDurations);
    await annotate(
      `selection handoff: subscriberMax=${maximumSubscriberDuration.toFixed(3)} ms, ` +
        `commitMax=${maximumCommitDuration.toFixed(3)} ms`,
      "performance",
    );
    expect(subscriberDurations).toHaveLength(5);
    expect(maximumSubscriberDuration).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(maximumCommitDuration).toBeLessThanOrEqual(timingBudget(100));
  }, 180_000);
});

function transformedContentCount(renderer: SvgSceneRenderer): number {
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[3]!;
  return content.nodes.filter(({ attributes }) => attributes.has("transform")).length;
}

function recordElement(record: { readonly element: unknown } | null): InkElementV1 | null {
  return record === null ? null : (record.element as InkElementV1);
}
