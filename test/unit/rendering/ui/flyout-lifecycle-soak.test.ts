import { describe, expect, it, vi } from "vitest";

import {
  createFlyoutPortalHost,
  registerFlyoutDismissal,
} from "../../../../src/rendering/ui/flyout-lifecycle";
import { createFlyoutPositionLifecycle } from "../../../../src/rendering/ui/flyout-position";

describe("flyout lifecycle soak", () => {
  it("releases portals, listeners, observers, and frames after repeated open-close cycles", () => {
    const fixture = lifecycleFixture();

    for (let cycle = 0; cycle < 25; cycle += 1) {
      const host = createFlyoutPortalHost(fixture.ownerDocument);
      const dismissal = registerFlyoutDismissal({
        anchor: fixture.trigger,
        canvasInput: fixture.canvas,
        onCanvasClose: vi.fn(),
        onEscapeClose: vi.fn(),
        ownerDocument: fixture.ownerDocument,
      });
      const position = createFlyoutPositionLifecycle(
        fixture.panel,
        fixture.trigger,
        fixture.ownerDocument,
      );
      position.reposition();
      dismissal();
      position.dispose();
      host.remove();
      expect(fixture.activeResources()).toEqual({
        frames: 0,
        listeners: 0,
        observers: 0,
        portals: 0,
      });
    }
  });
});

function lifecycleFixture() {
  let frames = 0;
  let observers = 0;
  let portals = 0;
  const documentListeners = listenerTarget();
  const windowListeners = listenerTarget();
  const canvasListeners = listenerTarget();
  const owningWindow = {
    ...windowListeners.target,
    ResizeObserver: class {
      #active = true;
      public constructor(_callback: ResizeObserverCallback) {
        observers += 1;
      }
      public disconnect(): void {
        if (!this.#active) return;
        this.#active = false;
        observers -= 1;
      }
      public observe(): void {}
    },
    cancelAnimationFrame: () => {
      frames = Math.max(0, frames - 1);
    },
    getComputedStyle: () => ({ overflowY: "visible" }),
    requestAnimationFrame: () => {
      frames += 1;
      return frames;
    },
  } as unknown as Window;
  const ownerDocument = {
    ...documentListeners.target,
    body: {
      createDiv: () => {
        portals += 1;
        let active = true;
        return {
          remove: () => {
            if (!active) return;
            active = false;
            portals -= 1;
          },
        };
      },
    },
    defaultView: owningWindow,
    documentElement: { clientHeight: 600, clientWidth: 800 },
    scrollingElement: null,
  } as unknown as Document;
  const trigger = {
    focus: vi.fn(),
    getBoundingClientRect: () => ({ bottom: 84, left: 80, top: 40 }),
    parentElement: null,
  } as unknown as HTMLElement;
  const panel = {
    offsetHeight: 160,
    offsetWidth: 220,
    style: { left: "", top: "" },
  } as unknown as HTMLElement;
  return {
    activeResources: () => ({
      frames,
      listeners: documentListeners.count() + windowListeners.count() + canvasListeners.count(),
      observers,
      portals,
    }),
    canvas: canvasListeners.target as unknown as HTMLElement,
    ownerDocument,
    panel,
    trigger,
  };
}

function listenerTarget() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    count: () => [...listeners.values()].reduce((count, values) => count + values.size, 0),
    target: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        const values = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        values.add(listener);
        listeners.set(type, values);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener);
      },
    },
  };
}
