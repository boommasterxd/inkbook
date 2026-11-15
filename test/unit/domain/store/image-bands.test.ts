import { describe, expect, it } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { RENDER_BANDS } from "../../../../src/domain/commands/render-bands";
import {
  applyElementMutation,
  applyRetainedHistoryMutation,
  uninterruptedMutationScheduler as scheduler,
} from "../../../fixtures/domain/element-mutation";
import { highlighter, image, PAGE, rectangle } from "./fixtures";

function orderedIds(store: ElementStore): string[] {
  const cursor = store.beginOrder();
  const ids: string[] = [];
  let step = cursor.advance();
  while (!step.done) {
    ids.push(step.id!);
    step = cursor.advance();
  }
  return ids;
}

const secondImage = () => image("00000000-0000-4000-8000-000000000051");

describe("image render band", () => {
  it("preserves fixed paint order through hydration, back insertion, and snapshot materialization", async () => {
    const first = image();
    const second = secondImage();
    const marker = highlighter();
    const shape = rectangle();
    const store = await ElementStore.createTimeSliced([shape, marker, first], scheduler);
    expect(store).not.toBeNull();
    store!.create(second, { placement: "back" });
    expect(orderedIds(store!)).toEqual([second.id, first.id, marker.id, shape.id]);
    expect(store!.getRank(first.id)).toEqual({ band: "image", rank: 1 });
    const snapshot = store!.materializeSnapshot({ page: PAGE, revision: 1 });
    expect(snapshot.version).toBe(3);
    expect(snapshot.elements.map(({ id }) => id)).toEqual(orderedIds(store!));
  });

  it("arranges a mixed selection only inside its band and replays both history directions", async () => {
    const first = image();
    const second = secondImage();
    const marker = highlighter();
    const marker2 = { ...marker, id: "00000000-0000-4000-8000-000000000052" };
    const shape = rectangle();
    const shape2 = rectangle("00000000-0000-4000-8000-000000000053");
    const store = new ElementStore([shape, first, marker, shape2, second, marker2]);
    const before = orderedIds(store);
    const prepared = await store.prepareElementArrangement(
      "bring-to-front",
      new Set([first.id, marker.id, shape.id]),
      scheduler,
    );
    const result = store.commitPreparedElementMutation(prepared.token!);
    expect(orderedIds(store)).toEqual([
      second.id,
      first.id,
      marker2.id,
      marker.id,
      shape2.id,
      shape.id,
    ]);
    expect(result.delta?.dirtyBands).toEqual({ image: true, highlight: true, content: true });
    await applyRetainedHistoryMutation(store, result.transition!, "reverse");
    expect(orderedIds(store)).toEqual(before);
    await applyRetainedHistoryMutation(store, result.transition!, "forward");
    expect(store.idAtRank("image", 1)).toBe(first.id);
    expect(
      (await store.prepareElementArrangement("bring-to-front", new Set([first.id]), scheduler))
        .status,
    ).toBe("noop");
  });

  it("retains image membership and crop through append, removal, and replay", async () => {
    const first = image();
    const store = new ElementStore([highlighter(), rectangle()]);
    const appended = await store.prepareElementAppend([first], scheduler);
    const addition = store.commitPreparedElementMutation(appended.token!);
    expect(addition.delta?.changes).toHaveLength(1);
    expect(addition.delta?.dirtyBands).toEqual({ image: true, highlight: false, content: false });
    const removed = store.removeWithHistory([first.id])!;
    expect(store.bandSize("image")).toBe(0);
    await applyElementMutation(store, removed.transition.reverse, removed.transition);
    expect(store.get(first.id)?.element).toEqual(first);
    await applyElementMutation(store, removed.transition.forward, removed.transition);
    expect(store.bandSize("image")).toBe(0);
    expect(RENDER_BANDS.map((band) => store.bandSize(band))).toEqual([0, 1, 1]);
  });

  it("classifies image crop replacements as paint and owns materialized resource headers", () => {
    const first = image();
    const store = new ElementStore([first]);
    const previous = store.get(first.id)!;
    const changed = { ...first, crop: { ...first.crop, x: 25, width: 175 } };
    const delta = store.replace(first.id, changed)!;
    expect(delta.changes[0]?.domains).toEqual(["paint"]);
    expect(store.get(first.id)?.geometryVersion).toBe(previous.geometryVersion);
    expect(store.get(first.id)?.paintVersion).toBeGreaterThan(previous.paintVersion);
    expect(store.replace(first.id, changed)).toBeNull();
    const resource = {
      id: first.assetId,
      mimeType: "image/png" as const,
      width: 200,
      height: 100,
      data: "AAAA",
    };
    const snapshot = store.materializeSnapshot({
      page: PAGE,
      revision: 1,
      imageResources: [resource],
    });
    expect(snapshot.imageResources).toEqual([resource]);
    snapshot.imageResources![0]!.width = 1;
    expect(resource.width).toBe(200);
  });
});
