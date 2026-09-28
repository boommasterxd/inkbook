import type { PageV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import type { SceneViewport } from "../../../src/rendering/scene/types";
import { FakeSceneStore } from "../../unit/rendering/scene/fakes";
import { indexedStroke } from "../editor/stroke";
import { createSceneFixture } from "./scene";

export const NAVIGATION_PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

const NAVIGATION_DOCUMENT_STROKES = 10_000;
export const NAVIGATION_VISIBLE_STROKES = 1_000;

/** A dense visible page of pressure handwriting within a larger offscreen document. */
export function createPressureNavigationHarness(
  viewport: SceneViewport = { height: 100, left: 0, top: 0, width: 100 },
) {
  const store = new FakeSceneStore();
  for (let index = 0; index < NAVIGATION_DOCUMENT_STROKES; index += 1) {
    const x = navigationStrokeX(index);
    const y = 20 + Math.floor((index % NAVIGATION_VISIBLE_STROKES) / 20);
    const element: StrokeElementV1 = {
      ...indexedStroke(index),
      pivot: { x, y },
      points: Array.from({ length: 24 }, (_, sample) => [
        x + sample / 4,
        y + Math.sin(sample / 3),
        0.35 + (0.6 * sample) / 23,
      ]).flat(),
    };
    store.records.set(element.id, {
      band: "content",
      bounds: { maxX: x + 8, maxY: y + 3, minX: x - 2, minY: y - 3 },
      element,
      geometryVersion: 1,
      id: element.id,
      paintVersion: 1,
      rank: index,
    });
  }
  return {
    ...createSceneFixture(NAVIGATION_PAGE, store, viewport),
    store,
  };
}

function navigationStrokeX(index: number): number {
  if (index < NAVIGATION_VISIBLE_STROKES) return 20 + (index % 20) * 2;
  // Crossing the overscan envelope adds one persistent and one alternating entrant.
  if (index === NAVIGATION_VISIBLE_STROKES) return 195;
  if (index === NAVIGATION_VISIBLE_STROKES + 1) return 245;
  return 1_000;
}
