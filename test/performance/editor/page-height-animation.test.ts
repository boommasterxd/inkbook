import { beforeAll, describe, expect, it } from "vitest";

import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { ActiveHeightTransition } from "../../../src/obsidian/embeds/active-editor/height-transition";
import { transitionDurations } from "../../../src/rendering/ui/motion";
import { createStandardRuntimeDomainFixture } from "../domain/standard-domain-fixture";
import { timingBudget } from "../timing-budget";

let store: ElementStore;

beforeAll(async () => {
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => Promise.resolve(),
  });
  expect(await builder.appendOwnedRuntime(createStandardRuntimeDomainFixture().elements)).toBe(
    "accepted",
  );
  const built = await builder.finalize();
  if (built === null) throw new Error("The page-height fixture was cancelled.");
  store = built;
});

describe("automatic page-height performance", () => {
  it("updates a 10,000-stroke bottom extent without scanning the store", async ({ annotate }) => {
    const baseline = store.getMaximumBottom();
    if (baseline === undefined) throw new Error("The fixture has no bottom extent.");
    const durations: number[] = [];

    for (let operation = 0; operation < 250; operation += 1) {
      const marker = bottomMarker(operation, baseline + 1_000);
      let started = performance.now();
      store.create(marker);
      expect(store.getMaximumBottom()).toBe(store.get(marker.id)?.bounds.maxY);
      durations.push(performance.now() - started);

      started = performance.now();
      store.remove([marker.id]);
      expect(store.getMaximumBottom()).toBe(baseline);
      durations.push(performance.now() - started);
    }

    const p99 = percentile(durations, 0.99);
    expect(p99).toBeLessThanOrEqual(timingBudget(4));
    expect(store.instrumentation.fullStoreScans).toBe(0);
    await annotate(`500 bottom-extent mutations: p99=${p99.toFixed(3)} ms, fullScans=0`);
  });

  it("keeps growth and shrink animation-frame orchestration below one millisecond", async ({
    annotate,
  }) => {
    const harness = transitionHarness();
    for (let transition = 0; transition < 500; transition += 1) {
      harness.run(transition % 2 === 0 ? [480, 720] : [720, 480]);
    }

    const p99 = percentile(harness.frameDurations, 0.99);
    expect(p99).toBeLessThanOrEqual(timingBudget(1));
    expect(harness.maximumFramesPerTransition).toBeLessThanOrEqual(12);
    expect(harness.incompleteTransitions).toBe(0);
    await annotate(`500 alternating growth/shrink transitions: frame p99=${p99.toFixed(3)} ms`);
  });
});

function bottomMarker(index: number, y: number): BoxShapeElementV1 {
  return {
    createdAt: index,
    height: 100,
    id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    kind: "rectangle",
    pivot: { x: 50, y: y + 50 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 100,
    x: 0,
    y,
  };
}

function transitionHarness() {
  const classNames = new Set<string>();
  const frames: FrameRequestCallback[] = [];
  const ownerWindow = {
    cancelAnimationFrame: () => frames.shift(),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  } as unknown as Window;
  const container = {
    classList: {
      add: (name: string) => classNames.add(name),
      remove: (name: string) => classNames.delete(name),
    },
    style: { removeProperty: () => "", setProperty: () => undefined },
  } as unknown as HTMLElement;
  const transition = new ActiveHeightTransition(container, ownerWindow);
  const frameDurations: number[] = [];
  let maximumFramesPerTransition = 0;
  let incompleteTransitions = 0;
  return {
    frameDurations,
    get incompleteTransitions() {
      return incompleteTransitions;
    },
    get maximumFramesPerTransition() {
      return maximumFramesPerTransition;
    },
    run: ([from, to]: readonly [number, number]) => {
      let completed = false;
      transition.begin({
        applyFrame: () => undefined,
        applySurfaceTarget: () => undefined,
        currentRenderedHeight: from,
        onComplete: () => {
          completed = true;
        },
        sceneCommitPending: () => false,
        targetRenderedHeight: to,
      });
      let elapsed = 0;
      let frameCount = 0;
      while (frames.length > 0) {
        const frame = frames.shift();
        if (frame === undefined) break;
        const started = performance.now();
        frame(elapsed);
        frameDurations.push(performance.now() - started);
        elapsed += 1000 / 60;
        frameCount += 1;
      }
      maximumFramesPerTransition = Math.max(maximumFramesPerTransition, frameCount);
      if (!completed || transition.active) incompleteTransitions += 1;
      expect(elapsed).toBeLessThanOrEqual(transitionDurations.automaticPageGrowth + 34);
    },
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}
