import { expect, it } from "vitest";
import { textCaretOcclusion } from "../../../../fixtures/obsidian/text-caret-occlusion";

it("reveals the focused caret above a phone inspector using the existing page lease and native scroll owner", () => {
  const state = textCaretOcclusion();
  try {
    expect(state.caretBottom()).toBeGreaterThan(320);
    state.reveal();
    expect(state.reserve).toHaveBeenCalledOnce();
    expect(state.layout.rect.height).toBeGreaterThan(state.original);
    expect(state.host.owner.scrollTop).toBe(0);
    state.flush();
    expect(state.host.owner.scrollTop).toBeGreaterThan(0);
    expect(state.caretBottom()).toBeLessThanOrEqual(304.001);
    state.reveal();
    expect(state.host.frames.pending).toBe(0);
    expect(state.reserve).toHaveBeenCalledOnce();
    state.ownerRect.height = 450;
    state.reveal(170);
    state.flush();
    expect(state.caretBottom()).toBeLessThanOrEqual(154.001);
    state.extent.reserveBottom(undefined);
    state.layout.work.flushFrames();
    expect(state.layout.rect.height).toBe(state.original);
  } finally {
    state.dispose();
  }
});

it("removes only the inspector reserve while retaining a taller source-reveal lease", () => {
  const state = textCaretOcclusion();
  try {
    state.sourceHeight(2500);
    state.layout.work.flushFrames();
    const sourceHeight = state.layout.rect.height;
    state.extent.reserveBottom(5000);
    expect(state.layout.rect.height).toBeGreaterThan(sourceHeight);
    state.extent.reserveBottom(undefined);
    state.layout.work.flushFrames();
    expect(state.layout.rect.height).toBe(sourceHeight);
    state.extent.dispose();
    state.layout.work.flushFrames();
    expect(state.layout.rect.height).toBe(state.original);
  } finally {
    state.dispose();
  }
});
