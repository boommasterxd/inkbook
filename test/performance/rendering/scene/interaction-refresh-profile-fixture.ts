import type { PageV1, StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  FakeDocument,
  FakeNode,
  FakeScheduler,
  asElement,
} from "../../../unit/rendering/scene/fakes";

export const INTERACTION_ELEMENT_COUNT = 10_000;
export const LIVE_STROKE_FRAME_COUNT = 450;
export const LIVE_STROKE_SAMPLES_PER_FRAME = 8;
export const LIVE_PRESSURE_STYLE: StrokeStyleV1 = {
  color: { type: "theme-text" },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 4,
};

export function createLivePressureSample(index: number, frameDurationMs: number, dense = false) {
  return {
    pressure: 0.35 + (index % 11) * 0.05,
    time: index * frameDurationMs,
    x: index * 0.75,
    y: 50 + Math.sin(index / (dense ? 1 : 20)) * 25,
  };
}

export const INTERACTION_PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

export function createInteractionFixture() {
  const elements = Array.from({ length: INTERACTION_ELEMENT_COUNT }, (_, index) =>
    indexedStroke(index),
  );
  return {
    elements,
    ids: elements.map((element) => element.id),
    store: new ElementStore(elements),
  };
}

export function createInteractionRenderer(
  store: ElementStore,
  options: {
    readonly frameBudgetMs?: () => number;
    readonly scheduler?: FakeScheduler;
  } = {},
) {
  const document = new FakeDocument();
  const scheduler = options.scheduler ?? new FakeScheduler();
  if (options.frameBudgetMs !== undefined) scheduler.frameBudgetMs = options.frameBudgetMs;
  const container = asElement(new FakeNode(document, "div"));
  const renderer = new SvgSceneRenderer({
    container,
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: INTERACTION_PAGE,
    workScheduler: scheduler.workScheduler,
    store: new ElementSceneStore(store),
  });
  return { renderer, scheduler };
}
