import type { EraserQueryCursor } from "../../../src/editor/gestures/eraser-gesture";

export function eraserQuery(ids: readonly string[]): EraserQueryCursor {
  let index = 0;
  let cancelled = false;
  return {
    advance(maxWorkUnits) {
      const end = cancelled ? index : Math.min(ids.length, index + maxWorkUnits);
      const batch = ids.slice(index, end);
      index = end;
      return {
        ids: batch,
        workUnits: batch.length,
        done: cancelled || index === ids.length,
        stale: false,
      };
    },
    cancel() {
      cancelled = true;
    },
  };
}
