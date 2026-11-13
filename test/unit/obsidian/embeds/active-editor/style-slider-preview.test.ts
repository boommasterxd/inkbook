import { afterEach, describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import {
  createSelectionFrameAtRotation,
  selectionOverlayGeometry,
} from "../../../../../src/editor/selection/public";
import { selectionOverlayPaths } from "../../../../../src/obsidian/embeds/active-editor/previews/selection-overlay-path";
import { layoutTextElement } from "../../../../fixtures/editor/text-style";
import { styleSliderFixture } from "../../../../fixtures/obsidian/style-slider";
import { textElement } from "../../../../fixtures/rendering/text";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

async function fixture(
  kind: "single" | "multiple" | "mixed" = "single",
  layout?: Parameters<typeof styleSliderFixture>[2],
) {
  const first = await layoutTextElement(
    textElement({ source: "Words wrap as the font grows", width: 120 }),
  );
  const selected =
    kind === "single"
      ? [first]
      : [
          first,
          await layoutTextElement(
            textElement({
              id: "00000000-0000-4000-8000-000000000002",
              x: 200,
              y: 200,
              ...(kind === "mixed" ? { style: { ...first.style, fontSize: 36 } } : {}),
            }),
          ),
        ];
  const result = styleSliderFixture(selected, [], layout);
  cleanup.push(result.dispose);
  return { ...result, selected };
}

describe("selected font size slider preview", () => {
  it.each(["single", "multiple", "mixed"] as const)(
    "previews %s selection text and matching bounds before changing the document",
    async (kind) => {
      const context = await fixture(kind);
      if (kind === "mixed") {
        expect(
          context.styles.presentation("select").controls.find(({ id }) => id === "text-font-size"),
        ).toMatchObject({ mixed: true });
      }
      context.styles.preview("select", "text-font-size", 48);
      await vi.waitFor(() => expect(context.renderer.setElementPreviews).toHaveBeenCalledOnce());
      const preview = context.renderer.setElementPreviews.mock.calls[0]![0];
      const text = preview.find(({ kind }) => kind === "text")!;
      expect(text).toMatchObject({ kind: "text", style: { fontSize: 48 } });
      expect(text.kind === "text" && text.height).toBeGreaterThan(
        context.selected[0]!.kind === "text" ? context.selected[0]!.height : 0,
      );
      const selected = preview.map((element) => ({
        element,
        bounds: calculateElementBounds(element),
      }));
      const frame = preview.length > 1 ? createSelectionFrameAtRotation(preview, 0) : null;
      const overlay = selectionOverlayPaths(
        selected,
        { pageToScreen: (point) => point, zoom: 1, focusedHandleIndex: null },
        selectionOverlayGeometry(selected, 1, null, frame),
      );
      expect(context.renderer.setSelectionOverlayPath).toHaveBeenLastCalledWith(
        overlay.outline,
        expect.any(String),
        overlay.handles,
      );
      for (const element of context.selected)
        expect(context.store.get(element.id)?.element).toEqual(element);
      expect(context.history.commandCount).toBe(0);
      expect(context.model.revision).toBe(0);
      expect(
        preview.every((element) => element.kind === "text" && element.style.fontSize === 48),
      ).toBe(true);
    },
  );

  it("commits the latest prepared preview once and replays one undo without repeating text layout", async () => {
    const context = await fixture();
    context.styles.preview("select", "text-font-size", 48);
    await vi.waitFor(() => expect(context.renderer.setElementPreviews).toHaveBeenCalledOnce());
    const preview = context.renderer.setElementPreviews.mock.calls[0]![0][0]!;
    context.styles.apply("select", "text-font-size", 48);
    context.styles.apply("select", "text-font-size", 48);
    context.styles.cancelPreview();
    await vi.waitFor(() => expect(context.history.commandCount).toBe(1));
    expect(context.reflow).toHaveBeenCalledOnce();
    expect(context.store.get(preview.id)?.element).toEqual(preview);
    expect(context.geometryChanged).toHaveBeenCalledOnce();
    await expect(context.history.undoAsync()).resolves.toBe(true);
    expect(context.store.get(preview.id)?.element).toEqual(context.selected[0]);
    await expect(context.history.undoAsync()).resolves.toBe(false);
    await expect(context.history.redoAsync()).resolves.toBe(true);
    expect(context.store.get(preview.id)?.element).toEqual(preview);
    expect(context.reflow).toHaveBeenCalledOnce();
  });

  it("clears an uncommitted visible preview when the menu closes", async () => {
    const context = await fixture();
    context.styles.preview("select", "text-font-size", 48);
    await vi.waitFor(() => expect(context.renderer.setElementPreviews).toHaveBeenCalledOnce());
    context.styles.cancelPreview();
    expect(context.renderer.clearElementPreviews).toHaveBeenCalledOnce();
    expect(context.geometryChanged).toHaveBeenCalledOnce();
    expect(context.history.commandCount).toBe(0);
    expect(context.store.get(context.selected[0]!.id)?.element).toEqual(context.selected[0]);
  });
});

describe("selected font size preview lifecycle", () => {
  it("keeps temporary page growth through preview updates and settles its lease on cancel or commit", async () => {
    const layout = {
      begin: vi.fn(),
      updateBottom: vi.fn<(bottom: number) => void>(),
      finish: vi.fn(),
    };
    const context = await fixture("multiple", layout);
    for (const [index, value] of [48, 60].entries()) {
      context.styles.preview("select", "text-font-size", value);
      await vi.waitFor(() =>
        expect(context.renderer.setElementPreviews).toHaveBeenCalledTimes(index + 1),
      );
      const elements = context.renderer.setElementPreviews.mock.calls[index]![0];
      const bottom = Math.max(...elements.map((element) => calculateElementBounds(element).maxY));
      expect(layout.updateBottom).toHaveBeenLastCalledWith(expect.any(Number));
      expect(layout.updateBottom.mock.lastCall![0]).toBeGreaterThanOrEqual(bottom);
      expect(layout.begin).toHaveBeenCalledOnce();
      expect(layout.finish).not.toHaveBeenCalled();
      expect(context.model.revision).toBe(0);
    }
    context.styles.cancelPreview();
    expect(layout.finish).toHaveBeenCalledExactlyOnceWith(false);
    context.styles.preview("select", "text-font-size", 72);
    await vi.waitFor(() => expect(context.renderer.setElementPreviews).toHaveBeenCalledTimes(3));
    context.styles.apply("select", "text-font-size", 72);
    context.styles.cancelPreview();
    await vi.waitFor(() => expect(layout.finish).toHaveBeenCalledTimes(2));
    expect(layout.begin).toHaveBeenCalledTimes(2);
    expect(layout.finish).toHaveBeenLastCalledWith(true);
    expect(context.history.commandCount).toBe(1);
  });

  it.each(["menu", "selection", "dispose"] as const)(
    "cancels %s closure while layout is pending",
    async (reason) => {
      const context = await fixture();
      const release = context.blockNextReflow();
      context.styles.preview("select", "text-font-size", 48);
      await vi.waitFor(() => expect(context.reflow).toHaveBeenCalledOnce());
      if (reason === "menu") context.styles.cancelPreview();
      else if (reason === "selection") context.changeSelection();
      else context.styles.dispose();
      expect(context.reflow.mock.calls[0]![1].aborted).toBe(true);
      release();
      await context.reflow.mock.results[0]!.value;
      await vi.waitFor(() => expect(context.renderer.clearElementPreviews).toHaveBeenCalled());
      expect(context.renderer.setElementPreviews).not.toHaveBeenCalled();
      expect(context.history.commandCount).toBe(0);
      expect(context.store.get(context.selected[0]!.id)?.element).toEqual(context.selected[0]);
    },
  );
});
