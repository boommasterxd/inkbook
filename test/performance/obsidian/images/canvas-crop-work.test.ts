// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { expect, it, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { openCanvasImageCrop } from "../../../../src/obsidian/images/canvas-image-crop";
import { imageElement, imageResource } from "../../../fixtures/domain/images";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

it("coalesces compact crop pointer feedback and releases queued work on abort", async () => {
  installObsidianDomHelpers();
  const container = document.createElement("div");
  const inputSurface = document.createElement("div");
  inputSurface.tabIndex = 0;
  document.body.append(container, inputSurface);
  const bounds = vi
    .spyOn(container, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 800, 600));
  const host = new ManualHost();
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: host.requestFrame,
    cancelAnimationFrame: host.cancelFrame,
  });
  const update = vi.fn();
  const dispose = vi.fn();
  const flush = vi.fn();
  const unsubscribe = vi.fn();
  const abort = new AbortController();
  const pending = openCanvasImageCrop({
    container,
    image: imageElement(),
    resource: imageResource(),
    localization: new Localization(),
    signal: abort.signal,
    scheduler,
    renderIcon: () => undefined,
    readMotion: () => "reduced",
    onActiveChanged: () => undefined,
    subscribeChanges: () => unsubscribe,
    renderer: {
      inputSurface,
      setElementPreviews: vi.fn(),
      flushPointerFeedbackFrame: flush,
      beginImageCrop: (_image, _resource, camera) => {
        camera({ x: 0, zoom: 0.75 });
        return { update, dispose };
      },
    },
  });
  expect(container.querySelector<HTMLElement>(".inkbook-image-crop-grips")?.dataset.compact).toBe(
    "true",
  );
  const handle = container.querySelector<HTMLButtonElement>('[data-edges="left"]')!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => false;
  handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1 }));
  bounds.mockClear();
  update.mockClear();
  flush.mockClear();
  for (let x = 1; x <= 30; x += 1)
    handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: x }));
  expect(bounds).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  expect(host.pendingFrames).toBe(1);
  host.frame();
  expect(update).toHaveBeenCalledOnce();
  expect(update).toHaveBeenLastCalledWith({ x: 80, y: 0, width: 320, height: 200 });
  expect(flush).toHaveBeenCalledOnce();
  expect(bounds).not.toHaveBeenCalled();
  handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 31 }));
  expect(host.pendingFrames).toBe(1);
  abort.abort();
  expect(await pending).toBeUndefined();
  expect(host.pendingFrames).toBe(0);
  expect(dispose).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(container.querySelectorAll("button")).toHaveLength(0);
  host.frame();
  expect(update).toHaveBeenCalledOnce();
  expect(flush).toHaveBeenCalledOnce();
  container.remove();
  inputSurface.remove();
});
