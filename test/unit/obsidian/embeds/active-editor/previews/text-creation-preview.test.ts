import { describe, expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { TextCreationPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/text-creation-preview";
import type { SvgSceneRenderer } from "../../../../../../src/rendering/scene";

function harness() {
  const create = vi.fn();
  const setLivePath = vi.fn<SvgSceneRenderer["setLivePath"]>();
  const preview = new TextCreationPreview({
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "mouse", x: 200, y: 50 },
      tool: "text",
    },
    defaults: createBuiltInSettings().toolDefaults.text,
    renderer: { setLivePath },
    create,
  });
  return { preview, create, setLivePath };
}

describe("text field creation", () => {
  it("opens a default-width field on click after clearing the creation preview", () => {
    const h = harness();
    expect(h.preview.commit()).toBe(true);
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ x: 200, y: 50, width: 400 });
    expect(h.setLivePath).toHaveBeenLastCalledWith(null);
    const calls = h.setLivePath.mock.invocationCallOrder;
    expect(calls[calls.length - 1]).toBeLessThan(h.create.mock.invocationCallOrder[0]!);
  });

  it("sets wrap width from a leftward drag while keeping the initial text top", () => {
    const h = harness();
    h.preview.update({ x: 75.12345, y: 400 });
    h.preview.commit();
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ x: 75.123, y: 50, width: 124.877 });
  });

  it("cancels the preview without creating a document element", () => {
    const h = harness();
    h.preview.update({ x: 500, y: 80 });
    h.preview.revert();
    expect(h.setLivePath).toHaveBeenLastCalledWith(null);
    expect(h.create).not.toHaveBeenCalled();
  });
});
