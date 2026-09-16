import { connectedPreviewDependents } from "./connected-input-fixture";
import { ElementStore } from "../../../src/domain/store/public";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { rectangle } from "../../unit/domain/store/fixtures";

export const CONNECTED_DEPENDENT_COUNT = 512;
const CONNECTED_SELECTION_STROKE_COUNT = 10_000;

export function createConnectedTranslationFixture() {
  const target = rectangle();
  const dependents = connectedPreviewDependents(target);
  const strokes = Array.from({ length: CONNECTED_SELECTION_STROKE_COUNT }, (_, index) =>
    indexedStroke(index),
  );
  return {
    selectedIds: new Set([target.id, ...strokes.map(({ id }) => id)]),
    store: new ElementStore([target, ...dependents, ...strokes]),
    target,
  };
}
