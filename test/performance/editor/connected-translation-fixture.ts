import { ElementStore } from "../../../src/domain/store/public";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";

export const CONNECTED_DEPENDENT_COUNT = 512;
const CONNECTED_SELECTION_STROKE_COUNT = 10_000;

export function createConnectedTranslationFixture() {
  const target = rectangle();
  const dependents = Array.from({ length: CONNECTED_DEPENDENT_COUNT }, (_, index) => ({
    ...connectedLine(target),
    createdAt: index + 2,
    id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
  }));
  const strokes = Array.from({ length: CONNECTED_SELECTION_STROKE_COUNT }, (_, index) =>
    indexedStroke(index),
  );
  return {
    selectedIds: new Set([target.id, ...strokes.map(({ id }) => id)]),
    store: new ElementStore([target, ...dependents, ...strokes]),
    target,
  };
}
