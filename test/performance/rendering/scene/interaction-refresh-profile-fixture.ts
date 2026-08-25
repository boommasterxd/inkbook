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

export const INTERACTION_ELEMENT_COUNT = 10_000;

export const INTERACTION_PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
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

export function createInteractionRenderer(store: ElementStore) {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const container = asElement(new FakeNode(document, "div"));
  const renderer = new SvgSceneRenderer({
    container,
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: INTERACTION_PAGE,
    scheduler,
    store: new ElementSceneStore(store),
  });
  return { renderer, scheduler };
}
