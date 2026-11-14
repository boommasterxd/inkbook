import type { PointV1, TextElementV2 } from "../../../src/domain/schema/public";
import type { WorkScheduler } from "../../../src/domain/scheduling/work-scheduler";
import type { SelectionSnapPorts } from "../../../src/editor/selection/handle-types";
import type { TextReflow } from "../../../src/editor/selection/transform/text-reflow-session";

export function deferredTextReflow() {
  const requests: {
    element: TextElementV2;
    signal: AbortSignal;
    resolve(value: TextElementV2): void;
  }[] = [];
  const reflow: TextReflow = (element, signal) =>
    new Promise((resolve) => requests.push({ element, signal, resolve }));
  return { requests, reflow };
}

export function emptyTextSnap(scheduler: WorkScheduler): SelectionSnapPorts {
  return {
    scheduler,
    pointerType: "mouse",
    spatial: { query: () => undefined },
    targets: { get: () => null },
    zoom: 1,
  };
}

export function scaledHandlePointer(anchor: PointV1, start: PointV1, factor: number): PointV1 {
  return {
    x: anchor.x + factor * (start.x - anchor.x),
    y: anchor.y + factor * (start.y - anchor.y),
  };
}
