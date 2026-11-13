import { expect, it, vi } from "vitest";
import { textCaretOcclusion } from "../../../../fixtures/obsidian/text-caret-occlusion";

it("grows native scroll space once and leaves an already visible caret without further layout or frames", () => {
  const state = textCaretOcclusion();
  const writes = vi.spyOn(state.layout.container.style, "blockSize", "set");
  try {
    state.reveal();
    expect(state.reserve).toHaveBeenCalledOnce();
    expect(writes).toHaveBeenCalledOnce();
    expect(state.host.frames.pending).toBe(1);
    state.flush();
    expect(state.host.sequence.filter((entry) => entry === "scroll")).toHaveLength(1);
    state.reveal();
    expect(state.host.frames.pending).toBe(0);
    expect(state.reserve).toHaveBeenCalledOnce();
    expect(writes).toHaveBeenCalledOnce();
    expect(state.host.sequence.filter((entry) => entry === "scroll")).toHaveLength(1);
  } finally {
    state.dispose();
  }
});
