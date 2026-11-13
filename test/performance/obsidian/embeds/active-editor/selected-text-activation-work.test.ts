// @vitest-environment happy-dom
import { beforeAll, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { textElement } from "../../../../fixtures/rendering/text";
import {
  selectedTextActivation,
  tapSelectedText,
  textActivationPointer,
} from "../../../../fixtures/obsidian/selected-text-activation";
import { appendOwnedIframe } from "../../../../fixtures/obsidian/owned-iframe";

beforeAll(installObsidianDomHelpers);

it("activates a selected text field without visiting 10000 unrelated strokes", () => {
  const text = textElement();
  const state = selectedTextActivation([
    text,
    ...Array.from({ length: 10_000 }, (_, index) => indexedStroke(index + 100)),
  ]);
  state.input.focus();
  state.key("Home");
  state.model.store.resetInstrumentation();
  const reads = vi.spyOn(state.model.store, "get");
  tapSelectedText(state.controller);
  expect(state.edit).toHaveBeenCalledExactlyOnceWith(text.id, text.source.length);
  expect(reads.mock.calls.every(([id]) => id === text.id)).toBe(true);
  // Warm selection geometry needs one host lookup, with fixed target/cursor refresh headroom.
  expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
  expect(state.model.store.instrumentation).toMatchObject({
    fullStoreScans: 0,
    bandScans: 0,
    timeSlicedIndexVisits: 0,
    reverseDependencyVisits: 0,
    publishedDeltas: 0,
  });
  const { frame, document: child } = appendOwnedIframe();
  const origin = vi
    .spyOn(frame, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(50, 70, 800, 600));
  const removeScroll = vi.spyOn(document, "removeEventListener");
  const removeResize = vi.spyOn(window, "removeEventListener");
  child.body.addEventListener("pointerdown", state.controller.handlePointerDown);
  const before = reads.mock.calls.length;
  for (const pointerType of ["mouse", "pen", "touch"] as const) {
    const down = textActivationPointer("pointerdown", pointerType, { clientX: 60, clientY: 0 });
    child.body.dispatchEvent(down);
    state.controller.handlePointerUp(textActivationPointer("pointerup", pointerType));
    expect(down.defaultPrevented).toBe(true);
  }
  expect(origin).toHaveBeenCalledTimes(3);
  expect(reads.mock.calls.length - before).toBe(3);
  expect(state.edit).toHaveBeenCalledOnce();
  expect(removeScroll.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(3);
  expect(removeResize.mock.calls.filter(([type]) => type === "resize")).toHaveLength(3);
  expect(state.model.store.instrumentation.fullStoreScans).toBe(0);
});
