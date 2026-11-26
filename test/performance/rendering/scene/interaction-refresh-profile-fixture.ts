import type { PageV1 } from "../../../../src/domain/schema/public";
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

const INTERACTION_ELEMENT_COUNT = 10_000;
export const LIVE_STROKE_FRAME_COUNT = 450;
export const LIVE_STROKE_SAMPLES_PER_FRAME = 8;
export function createLivePressureSample(index: number, frameDurationMs: number) {
  return {
    pressure: 0.35 + (index % 11) * 0.05,
    time: index * frameDurationMs,
    x: index * 0.75,
    y: 50 + Math.sin(index / 20) * 25,
  };
}

const INTERACTION_PAGE: PageV1 = {
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
    ids: elements.map((element) => element.id),
    store: new ElementStore(elements),
  };
}

export function createInteractionRenderer(store: ElementStore, scheduler = new FakeScheduler()) {
  const document = new FakeDocument();
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
