import { describe, expect, it, vi } from "vitest";

import { MAX_STROKE_POINTS } from "../../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { CreationPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import {
  activeEditorStoreHistory,
  creationPreviewRenderer,
} from "../../../../../fixtures/obsidian/active-editor";

const strokeId = "00000000-0000-4000-8000-000000000025";
const curve = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => ({
  pointerId: 1,
  pointerType: "pen" as const,
  pressure: 0.6,
  time: index,
  x: index,
  y: Math.round(12 * Math.sin((index * Math.PI) / 12) * 1000) / 1000 + 0,
}));
const expectedCoordinates = curve.flatMap(({ x, y }) => [x, y]);
const overflow = [
  { ...curve[0]!, time: MAX_STROKE_POINTS, x: 100_000, y: 100_000 },
  { ...curve[0]!, time: MAX_STROKE_POINTS + 1, x: -100_000, y: -100_000 },
];

describe("active editor single-stroke capacity", () => {
  it.each([true, false])(
    "retains the complete long curve and one history command with pressure %s",
    (pressureEnabled) => {
      const { commitLiveStroke, history, notice, preview, store, updateLiveStroke } =
        harness(pressureEnabled);
      appendCurve(preview);
      expect(notice).not.toHaveBeenCalled();

      preview.updateSamples(overflow);
      updateLiveStroke.mockClear();
      preview.updateSamples([{ ...overflow[0]!, time: MAX_STROKE_POINTS + 2 }]);
      expect(notice).toHaveBeenCalledOnce();
      expect(updateLiveStroke).not.toHaveBeenCalled();
      expect(preview.commit()).toBe(true);
      expect(store.size).toBe(1);
      expect(history.commandCount).toBe(1);
      expect(commitLiveStroke).toHaveBeenCalledExactlyOnceWith(
        strokeId,
        expect.objectContaining({
          points: expect.any(Array) as unknown,
          geometryMemoryBytes: expect.any(Number) as unknown,
        }),
      );

      const element = store.get(strokeId)?.element;
      if (element?.kind !== "stroke") throw new Error("Expected a single committed stroke.");
      expect(element.style.pressureEnabled).toBe(pressureEnabled);
      expect(element.points).toHaveLength(MAX_STROKE_POINTS * 3);
      expect(element.points.filter((_value, index) => index % 3 !== 2)).toEqual(
        expectedCoordinates,
      );

      expect(history.undo()).toBe(true);
      expect(store.size).toBe(0);
      expect(history.canUndo).toBe(false);
      expect(history.redo()).toBe(true);
      expect(store.size).toBe(1);
      expect(store.get(strokeId)?.element).toEqual(element);
    },
    20_000,
  );

  it("discards an exhausted preview on cancellation without creating a history command", () => {
    const { clearLiveStroke, commitLiveStroke, history, notice, preview, store } = harness(true);
    appendCurve(preview);
    preview.updateSamples(overflow);
    expect(notice).toHaveBeenCalledOnce();

    preview.revert();
    preview.revert();
    expect(store.size).toBe(0);
    expect(history.commandCount).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(clearLiveStroke).toHaveBeenCalledOnce();
    expect(commitLiveStroke).not.toHaveBeenCalled();
  }, 20_000);
});

function appendCurve(preview: CreationPreview): void {
  for (let offset = 1; offset < curve.length; offset += 256) {
    preview.updateSamples(curve.slice(offset, offset + 256));
  }
}

function harness(pressureEnabled: boolean) {
  const store = new ElementStore();
  const history = activeEditorStoreHistory(store);
  const notice = vi.fn();
  const defaults = createBuiltInSettings().toolDefaults;
  const clearLiveStroke = vi.fn();
  const commitLiveStroke = vi.fn();
  const updateLiveStroke = vi.fn();
  const renderer = creationPreviewRenderer({ clearLiveStroke, commitLiveStroke, updateLiveStroke });
  const preview = new CreationPreview({
    defaults: { ...defaults, pen: { ...defaults.pen, pressureEnabled } },
    history,
    identity: { createdAt: 1, id: strokeId },
    onStrokeCapacityReached: notice,
    renderer,
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: curve[0]!,
      tool: "draw",
    },
  });
  return { clearLiveStroke, commitLiveStroke, history, notice, preview, store, updateLiveStroke };
}
