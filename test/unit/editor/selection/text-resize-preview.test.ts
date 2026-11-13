import { describe, expect, it } from "vitest";
import { scaledHandlePointer } from "../../../fixtures/editor/text-handle-session";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import type { ImmutableInkElement } from "../../../../src/domain/store/types";
import { SelectionHandleSession } from "../../../../src/editor/selection/handle-session";
import { oppositeElementHandlePoint } from "../../../../src/editor/selection/handles";
import { selectionOverlayGeometry } from "../../../../src/editor/selection/overlay-geometry";
import {
  selectionFramePoint,
  type OrientedSelectionFrame,
} from "../../../../src/editor/selection/selection-frame";
import { textElement } from "../../domain/schema/fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

function assertFrameHandles(value: ImmutableInkElement, frame: OrientedSelectionFrame | null) {
  const element = value as InkElementV1;
  const selected = [{ element, bounds: calculateElementBounds(element) }];
  const geometry = selectionOverlayGeometry(selected, 1, null, frame)!;
  if (geometry.outline.kind !== "polygon") throw new Error("Expected a text selection rectangle.");
  const actualFrame = {
    points: geometry.outline.points,
    rotation: element.rotation,
  } as OrientedSelectionFrame;
  if (frame !== null) expect(actualFrame.points).toEqual(frame.points);
  const handles = geometry.handles.filter((handle) => handle.kind === "scale");
  expect(handles).toHaveLength(6);
  for (const handle of handles) {
    const point = selectionFramePoint(actualFrame, handle.position);
    expect(handle.point.x).toBeCloseTo(point.x, 10);
    expect(handle.point.y).toBeCloseTo(point.y, 10);
    expect(["top-center", "bottom-center"]).not.toContain(handle.position);
  }
  return actualFrame;
}

async function replace(store: ElementStore, elements: readonly InkElementV1[]) {
  const prepared = await store.prepareElementReplacement(elements, scheduler);
  if (prepared.token === null) throw new Error("Expected prepared resize replacement.");
  const result = store.commitPreparedElementReplacement(prepared.token);
  if (result.history === null) throw new Error("Expected resize history.");
  return result.history;
}

describe("text resize selection frame", () => {
  it.each([0, 30, 90])(
    "keeps corner preview, commit and history handles on the field rectangle at %s degrees",
    async (rotation) => {
      const text = { ...textElement(), rotation };
      const store = new ElementStore([text]);
      const original = assertFrameHandles(text, null);
      const start = selectionFramePoint(original, "bottom-right");
      const anchor = oppositeElementHandlePoint(text, "bottom-right");
      const session = new SelectionHandleSession({
        action: { kind: "scale", position: "bottom-right", anchor, rotation },
        elements: [text],
        startPointer: start,
        planner: store,
      });
      const preview = session.update(scaledHandlePointer(anchor, start, 2));
      expect(preview.transform?.kind).toBe("scale");
      expect(preview.previewFrame).not.toBeNull();
      const projected = assertFrameHandles(text, preview.previewFrame);
      const commit = await session.prepareCommitTimeSliced(scheduler);
      if (commit.status !== "ready") throw new Error("Expected completed text resize.");
      const history = await replace(store, commit.replacements);
      const resized = store.get(text.id)!.element;
      expect(resized).toMatchObject({ width: 200, height: 100, style: { fontSize: 33 } });
      const committed = assertFrameHandles(resized, null);
      for (let index = 0; index < 4; index += 1) {
        expect(committed.points[index]!.x).toBeCloseTo(projected.points[index]!.x, 2);
        expect(committed.points[index]!.y).toBeCloseTo(projected.points[index]!.y, 2);
      }
      await replace(store, history.previous as InkElementV1[]);
      expect(assertFrameHandles(store.get(text.id)!.element, null)).toEqual(original);
      await replace(store, history.replacements as InkElementV1[]);
      expect(assertFrameHandles(store.get(text.id)!.element, null)).toEqual(committed);
    },
  );
});
