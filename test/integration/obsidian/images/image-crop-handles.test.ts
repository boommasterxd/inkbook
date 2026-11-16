// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { describe, expect, it, vi } from "vitest";
import { ImageCropDraft } from "../../../../src/obsidian/images/image-crop-draft";
import { ImageCropHandles } from "../../../../src/obsidian/images/image-crop-handles";

function setup() {
  const outline = document.createElement("div");
  document.body.append(outline);
  const draft = new ImageCropDraft(
    { width: 200, height: 100 },
    { x: 20, y: 10, width: 160, height: 80 },
  );
  const update = vi.fn();
  const handles = new ImageCropHandles({
    outline,
    draft,
    update,
    t: (key) => key,
    sourcePoint: (event) => ({ x: event.clientY * 2, y: -event.clientX * 2 }),
  });
  const button = (edges: string): HTMLButtonElement => {
    const target = outline.querySelector<HTMLButtonElement>(`[data-edges="${edges}"]`)!;
    target.setPointerCapture = vi.fn();
    target.hasPointerCapture = () => true;
    target.releasePointerCapture = vi.fn();
    return target;
  };
  return { outline, draft, update, handles, button };
}

function pointer(target: HTMLElement, type: string, pointerId: number, x = 0, y = 0): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}

describe("image crop handles", () => {
  it("uses mapped source coordinates, clamps corner edges, and commits only the draft", () => {
    const { draft, handles, button, outline } = setup();
    const handle = button("left top");
    const bubbled = vi.fn();
    outline.addEventListener("pointerdown", bubbled);
    expect(pointer(handle, "pointerdown", 1, 0, 0).defaultPrevented).toBe(true);
    pointer(handle, "pointermove", 1, -100, 100);
    pointer(handle, "pointerup", 1, -100, 100);
    expect(draft.crop).toEqual({ x: 179, y: 89, width: 1, height: 1 });
    expect(bubbled).not.toHaveBeenCalled();
    handles.dispose();
    outline.remove();
  });

  it("moves with pointer and keyboard within the resource while preserving size", () => {
    const { draft, handles, button, outline } = setup();
    const move = button("move");
    pointer(move, "pointerdown", 1);
    pointer(move, "pointermove", 1, -100, 100);
    pointer(move, "pointerup", 1, -100, 100);
    expect(draft.crop).toEqual({ x: 40, y: 20, width: 160, height: 80 });
    const key = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    move.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(draft.crop.x).toBe(30);
    button("right").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(draft.crop.width).toBe(159);
    handles.dispose();
    outline.remove();
  });

  it("ignores other pointers, rolls back cancellation and removes handles on disposal", () => {
    const { draft, handles, button, outline } = setup();
    const handle = button("left");
    const release = vi.spyOn(handle, "releasePointerCapture");
    pointer(handle, "pointerdown", 1);
    pointer(handle, "pointermove", 1, 0, 5);
    pointer(handle, "pointerup", 2);
    pointer(handle, "pointermove", 1, 0, 10);
    expect(draft.crop.x).toBe(40);
    pointer(handle, "lostpointercapture", 1);
    expect(draft.crop.x).toBe(20);
    pointer(handle, "pointerdown", 3);
    pointer(handle, "pointermove", 3, 0, 5);
    pointer(handle, "pointercancel", 3);
    expect(draft.crop.x).toBe(20);
    pointer(handle, "pointerdown", 4);
    pointer(handle, "pointermove", 4, 0, 5);
    handles.dispose();
    expect(draft.crop.x).toBe(20);
    expect(release).toHaveBeenCalled();
    expect(outline.querySelectorAll("button")).toHaveLength(0);
    outline.remove();
  });
});

it("uses the release position when it differs from the last crop movement", () => {
  const { draft, handles, button, outline } = setup();
  const handle = button("left");
  pointer(handle, "pointerdown", 1);
  pointer(handle, "pointermove", 1, 0, 5);
  expect(draft.crop.x).toBe(30);
  pointer(handle, "pointerup", 1, 0, 15);
  expect(draft.crop).toEqual({ x: 50, y: 10, width: 130, height: 80 });
  handles.dispose();
  outline.remove();
});
