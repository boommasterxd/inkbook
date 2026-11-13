import { expect, it, vi } from "vitest";

import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { layoutTextElement } from "../../../../fixtures/editor/text-style";
import { styleSliderFixture } from "../../../../fixtures/obsidian/style-slider";
import { textElement } from "../../../../fixtures/rendering/text";

it("keeps one running layout and the latest request without reading 10000 unrelated strokes", async () => {
  const text = await layoutTextElement(textElement());
  const context = styleSliderFixture(
    [text],
    Array.from({ length: 10_000 }, (_, index) => indexedStroke(index + 100)),
  );
  const reads = vi.spyOn(context.store, "get");
  const initialWork = context.store.instrumentation;
  const release = context.blockNextReflow();
  try {
    context.styles.preview("select", "text-font-size", 25);
    await vi.waitFor(() => expect(context.reflow).toHaveBeenCalledOnce());
    for (let value = 26; value <= 96; value += 1)
      context.styles.preview("select", "text-font-size", value);
    expect(context.reflow).toHaveBeenCalledOnce();
    expect(context.reflow.mock.calls[0]![1].aborted).toBe(true);
    expect(context.renderer.setElementPreviews).not.toHaveBeenCalled();
    expect(reads.mock.calls.every(([id]) => id === text.id)).toBe(true);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
    context.styles.apply("select", "text-font-size", 96);
    context.styles.cancelPreview();
    release();
    await vi.waitFor(() => expect(context.history.commandCount).toBe(1));
    expect(context.reflow).toHaveBeenCalledTimes(2);
    expect(context.reflow.mock.calls.map(([element]) => element.style.fontSize)).toEqual([25, 96]);
    expect(context.store.get(text.id)?.element).toMatchObject({ style: { fontSize: 96 } });
    expect(reads.mock.calls.every(([id]) => id === text.id)).toBe(true);
    // Selected preparation, frame rebase and model validation may revisit this record;
    // work stays independent of the number of INPUT events and unrelated records.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(20);
    expect(context.renderer.setElementPreviews.mock.calls.length).toBeLessThanOrEqual(1);
    expect(context.store.instrumentation.fullStoreScans).toBe(initialWork.fullStoreScans);
    expect(context.store.instrumentation.bandScans).toBe(initialWork.bandScans);
    await expect(context.history.undoAsync()).resolves.toBe(true);
    expect(context.store.get(text.id)?.element).toEqual(text);
    await expect(context.history.undoAsync()).resolves.toBe(false);
    expect(context.reflow).toHaveBeenCalledTimes(2);
  } finally {
    release();
    context.dispose();
    reads.mockRestore();
  }
});
