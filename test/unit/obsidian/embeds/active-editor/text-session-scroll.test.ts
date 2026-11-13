import { describe, expect, it, vi } from "vitest";
import { prepareTextCaretReveal } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";

describe("text caret host reveal adapter", () => {
  it("maps iframe client coordinates to existing page navigation and consumes an already visible reveal", () => {
    const rect = { left: 20, right: 21, top: 5000, bottom: 5024 };
    const bounds = { minX: 40, maxX: 42, minY: 10_000, maxY: 10_048 };
    const pageBoundsForClientRect = vi.fn(() => bounds);
    const surface = { pageBoundsForClientRect } as unknown as TextEditingSurface;
    const reveal = vi.fn();
    const prepared = prepareTextCaretReveal(surface, rect, reveal);
    expect(reveal).not.toHaveBeenCalled();
    expect(prepared?.()).toBe(true);
    expect(pageBoundsForClientRect).toHaveBeenCalledExactlyOnceWith(rect);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(bounds);
  });

  it("allows fallback only when no public page-coordinate mapping is available", () => {
    const rect = { left: 0, right: 0, top: 0, bottom: 0 };
    const surface = { pageBoundsForClientRect: () => undefined } as unknown as TextEditingSurface;
    const reveal = vi.fn();
    expect(prepareTextCaretReveal(surface, rect, reveal)).toBeUndefined();
    expect(reveal).not.toHaveBeenCalled();
  });
});
