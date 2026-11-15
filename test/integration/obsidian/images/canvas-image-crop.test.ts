// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { describe, expect, it, vi } from "vitest";
import type { Scope } from "obsidian";
import { Localization } from "../../../../src/domain/localization";
import type { ImageElementV3, ImageResourceV3 } from "../../../../src/domain/schema/public";
import { openCanvasImageCrop } from "../../../../src/obsidian/images/canvas-image-crop";
import { installDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

installDialogTestLifecycle();

function setup(rotation = 0, camera = { x: 0, zoom: 1 }) {
  const container = document.createElement("div");
  const inputSurface = document.createElement("div");
  inputSurface.tabIndex = 0;
  document.body.append(container, inputSurface);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  const resource: ImageResourceV3 = {
    id: "a".repeat(64),
    mimeType: "image/png",
    width: 200,
    height: 100,
    data: "AAAA",
  };
  const image: ImageElementV3 = {
    id: "image",
    kind: "image",
    createdAt: 1,
    rotation,
    pivot: { x: 100, y: 50 },
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    assetId: resource.id,
    crop: { x: 20, y: 10, width: 160, height: 80 },
  };
  const update = vi.fn();
  const dispose = vi.fn();
  const setElementPreviews = vi.fn();
  const flushPointerFeedbackFrame = vi.fn();
  const active = vi.fn();
  const unsubscribe = vi.fn();
  let cancelChange = (): void => undefined;
  const signal = new AbortController();
  const keymap = {
    pushScope: vi.fn<(scope: Scope) => void>(),
    popScope: vi.fn<(scope: Scope) => void>(),
  };
  const promise = openCanvasImageCrop({
    container,
    image,
    resource,
    signal: signal.signal,
    keymap,
    localization: new Localization(),
    scheduler: new TestWorkScheduler(),
    renderIcon: () => undefined,
    readMotion: () => "reduced",
    onActiveChanged: active,
    subscribeChanges: (cancel) => {
      cancelChange = cancel;
      return unsubscribe;
    },
    renderer: {
      inputSurface,
      beginImageCrop: (_image, _resource, onCamera) => {
        onCamera(camera);
        return { update, dispose };
      },
      flushPointerFeedbackFrame,
      setElementPreviews,
    },
  });
  const button = (label: string): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (found === null) throw new Error(`Missing button: ${label}`);
    return found;
  };
  return {
    container,
    image,
    inputSurface,
    promise,
    button,
    update,
    dispose,
    setElementPreviews,
    flushPointerFeedbackFrame,
    active,
    unsubscribe,
    signal,
    keymap,
    cancelChange: () => cancelChange(),
  };
}

function key(target: HTMLElement, name: string, shiftKey = false): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true }),
  );
}

describe("inline canvas image crop", () => {
  it("keeps compatibility mouse clicks inside crop controls away from the host editor", async () => {
    const crop = setup();
    const hostClick = vi.fn();
    const hostMouseDown = vi.fn();
    crop.container.addEventListener("click", hostClick);
    crop.container.addEventListener("mousedown", hostMouseDown);
    const handle = crop.container.querySelector<HTMLButtonElement>('[data-edges="left"]')!;
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    handle.click();
    crop.button("Cancel").click();
    expect(await crop.promise).toBeUndefined();
    expect(hostClick).not.toHaveBeenCalled();
    expect(hostMouseDown).not.toHaveBeenCalled();
  });

  it("exposes named controls and confirms a keyboard-edited draft without mutating the image", async () => {
    const crop = setup();
    const group = crop.container.querySelector<HTMLElement>(
      '[role="group"][aria-label="Crop image"]',
    );
    expect(group).not.toBeNull();
    expect(group?.getAttribute("aria-describedby")).toBeTruthy();
    expect(crop.button("Cancel")).toBeDefined();
    expect(crop.button("Apply crop")).toBeDefined();
    const handle = crop.container.querySelector<HTMLButtonElement>('[data-edges="left top"]')!;
    expect(handle.getAttribute("aria-label")).toBeTruthy();
    expect(document.activeElement).toBe(handle);
    key(handle, "ArrowRight", true);
    key(handle, "ArrowDown");
    expect(crop.update).toHaveBeenLastCalledWith({ x: 30, y: 11, width: 150, height: 79 });
    key(handle, "Enter");
    expect(await crop.promise).toEqual({ x: 30, y: 11, width: 150, height: 79 });
    expect(crop.image.crop).toEqual({ x: 20, y: 10, width: 160, height: 80 });
    expect(document.activeElement).toBe(crop.inputSurface);
    expect(crop.active.mock.calls).toEqual([[true], [false]]);
    expect(crop.dispose).toHaveBeenCalledOnce();
    expect(crop.setElementPreviews).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ crop: { x: 30, y: 11, width: 150, height: 79 } })],
      1,
    );
    expect(crop.setElementPreviews.mock.invocationCallOrder[0]).toBeLessThan(
      crop.dispose.mock.invocationCallOrder[0]!,
    );
    const flushes = crop.flushPointerFeedbackFrame.mock.invocationCallOrder;
    expect(flushes[flushes.length - 1]).toBeLessThan(crop.dispose.mock.invocationCallOrder[0]!);
    expect(crop.unsubscribe).toHaveBeenCalledOnce();
    expect(crop.container.querySelector('[role="group"]')).toBeNull();
  });

  it.each(["Escape", "Cancel"])("discards a draft through %s", async (method) => {
    const crop = setup();
    const handle = crop.container.querySelector<HTMLButtonElement>('[data-edges="left"]')!;
    key(handle, "ArrowRight");
    if (method === "Escape") key(handle, "Escape");
    else crop.button("Cancel").click();
    expect(await crop.promise).toBeUndefined();
    expect(crop.image.crop.x).toBe(20);
    expect(crop.dispose).toHaveBeenCalledOnce();
    expect(crop.active.mock.calls).toEqual([[true], [false]]);
  });

  it("maps pointer movement through camera zoom and image rotation", async () => {
    const crop = setup(90, { x: 10, zoom: 2 });
    const handle = crop.container.querySelector<HTMLButtonElement>('[data-edges="left"]')!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => false;
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 20 }));
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    key(handle, "Enter");
    expect(await crop.promise).toEqual({ x: 28, y: 10, width: 152, height: 80 });
  });

  it.each(["abort", "change"])(
    "releases the presentation and controls on external %s",
    async (reason) => {
      const crop = setup();
      if (reason === "abort") crop.signal.abort();
      else crop.cancelChange();
      expect(await crop.promise).toBeUndefined();
      expect(crop.container.querySelector('[role="group"]')).toBeNull();
      expect(crop.dispose).toHaveBeenCalledOnce();
      expect(crop.unsubscribe).toHaveBeenCalledOnce();
      expect(crop.keymap.pushScope).toHaveBeenCalledOnce();
      expect(crop.keymap.popScope).toHaveBeenCalledExactlyOnceWith(
        crop.keymap.pushScope.mock.calls[0]![0],
      );
      expect(crop.active.mock.calls).toEqual([[true], [false]]);
      crop.signal.abort();
      crop.cancelChange();
      expect(crop.dispose).toHaveBeenCalledOnce();
    },
  );
});
