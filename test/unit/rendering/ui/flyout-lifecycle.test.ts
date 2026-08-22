import { describe, expect, it, vi } from "vitest";

import {
  createFlyoutPortalHost,
  registerFlyoutDismissal,
} from "../../../../src/rendering/ui/flyout-lifecycle";

function keyboardEvent(key: string): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event as KeyboardEvent;
}

describe("flyout lifecycle", () => {
  it("creates a scoped portal in the supplied owner document", () => {
    const host = { className: "", remove: vi.fn() };
    const createDiv = vi.fn(() => host);
    const ownerDocument = {
      body: { createDiv },
    } as unknown as Document;

    expect(createFlyoutPortalHost(ownerDocument)).toBe(host);
    expect(createDiv).toHaveBeenCalledWith({ cls: "inkbook-root inkbook-portal-root" });
  });

  it("closes on Escape, restores trigger focus, and cleans up listeners", () => {
    const ownerDocument = new EventTarget();
    const canvasInput = new EventTarget();
    const focus = vi.fn();
    const onEscapeClose = vi.fn();
    const onCanvasClose = vi.fn();
    const cleanup = registerFlyoutDismissal({
      anchor: { focus } as unknown as HTMLElement,
      canvasInput: canvasInput as unknown as HTMLElement,
      onCanvasClose,
      onEscapeClose,
      ownerDocument: ownerDocument as unknown as Document,
    });

    ownerDocument.dispatchEvent(keyboardEvent("Enter"));
    ownerDocument.dispatchEvent(keyboardEvent("Escape"));
    canvasInput.dispatchEvent(new Event("pointerdown"));
    expect(onEscapeClose).toHaveBeenCalledOnce();
    expect(onCanvasClose).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();

    cleanup();
    ownerDocument.dispatchEvent(keyboardEvent("Escape"));
    canvasInput.dispatchEvent(new Event("pointerdown"));
    expect(onEscapeClose).toHaveBeenCalledOnce();
    expect(onCanvasClose).not.toHaveBeenCalled();
  });

  it("closes once on a canvas interaction", () => {
    const ownerDocument = new EventTarget();
    const canvasInput = new EventTarget();
    const onCanvasClose = vi.fn();
    registerFlyoutDismissal({
      anchor: { focus: vi.fn() } as unknown as HTMLElement,
      canvasInput: canvasInput as unknown as HTMLElement,
      onCanvasClose,
      onEscapeClose: vi.fn(),
      ownerDocument: ownerDocument as unknown as Document,
    });

    canvasInput.dispatchEvent(new Event("pointerdown"));
    canvasInput.dispatchEvent(new Event("pointerdown"));
    expect(onCanvasClose).toHaveBeenCalledOnce();
  });
});
