import type { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceRuntimeLifecycle } from "../../../src/obsidian/embeds/workspace/workspace-runtime-lifecycle";
import { InkbookFeedbackManager } from "../../../src/obsidian/feedback";
import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";

function createHarness() {
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView!;
  const host = new ManualHost();
  Object.assign(ownerWindow, {
    closed: false,
    setTimeout: host.setTimer,
    clearTimeout: host.clearTimer,
  });
  const lifecycle = new WorkspaceRuntimeLifecycle({
    activate: vi.fn(),
    fallbackWindow: () => ownerWindow,
    isDisposed: () => false,
    notifyExternalChange: async () => "ignored",
    presentations: () => [],
    reloadPresentation: vi.fn(),
    vault: { getFileByPath: () => null } as unknown as Vault,
    workScheduler: () => immediateWorkScheduler(),
  });
  const persistStroke = (documentId: string): void => {
    lifecycle.markFirstStroke(documentId);
    lifecycle.handlePersisted({
      documentId,
      lockedAspectRatio: 4,
      outputHash: "hash",
      revision: 1,
    });
  };
  return { host, lifecycle, ownerWindow, persistStroke, root };
}

function observeNativeFeedbackAnimations() {
  const previousAnimate = Object.getOwnPropertyDescriptor(
    FakePresentationElement.prototype,
    "animate",
  );
  const previousGetAnimations = Object.getOwnPropertyDescriptor(
    FakePresentationElement.prototype,
    "getAnimations",
  );
  const animations: Array<{
    cancel: ReturnType<typeof vi.fn>;
    onfinish: (() => void) | null;
  }> = [];
  const animate = vi.fn((_keyframes: unknown, _options: unknown) => {
    const animation = {
      cancel: vi.fn(),
      currentTime: 0,
      finished: new Promise<void>(() => undefined),
      onfinish: null as (() => void) | null,
    };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  Object.defineProperty(FakePresentationElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  const getAnimations = vi.fn(
    () =>
      animations.filter(
        (animation) => animation.cancel.mock.calls.length === 0,
      ) as unknown as Animation[],
  );
  Object.defineProperty(FakePresentationElement.prototype, "getAnimations", {
    configurable: true,
    value: getAnimations,
  });
  return {
    animate,
    animations,
    getAnimations,
    cleanup: (): void => {
      if (previousAnimate === undefined)
        Reflect.deleteProperty(FakePresentationElement.prototype, "animate");
      else Object.defineProperty(FakePresentationElement.prototype, "animate", previousAnimate);
      if (previousGetAnimations === undefined)
        Reflect.deleteProperty(FakePresentationElement.prototype, "getAnimations");
      else
        Object.defineProperty(
          FakePresentationElement.prototype,
          "getAnimations",
          previousGetAnimations,
        );
    },
  };
}

describe("insertion feedback ownership", () => {
  it("releases every aborted insertion instead of retaining its dismissal callback", () => {
    const h = createHarness();
    const dismiss = vi.fn();
    for (let index = 0; index < 100; index += 1) {
      const documentId = `drawing-${String(index)}.svg`;
      h.lifecycle.queueAutoActivation(documentId, h.ownerWindow, vi.fn(), dismiss);
      h.lifecycle.abortAutoActivation(documentId);
    }
    for (let index = 0; index < 100; index += 1) h.persistStroke(`drawing-${String(index)}.svg`);
    expect(dismiss).not.toHaveBeenCalled();
    expect(h.host.pendingTimers).toBe(0);
    h.lifecycle.dispose();
  });

  it("does not release a replacement hint through a stale close notification", () => {
    const h = createHarness();
    const oldDismiss = vi.fn();
    const dismiss = vi.fn();
    const release = h.lifecycle.queueAutoActivation(
      "drawing.svg",
      h.ownerWindow,
      vi.fn(),
      oldDismiss,
    );
    h.lifecycle.queueAutoActivation("drawing.svg", h.ownerWindow, vi.fn(), dismiss);
    release();
    h.persistStroke("drawing.svg");
    h.persistStroke("drawing.svg");
    expect(oldDismiss).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledOnce();
    h.lifecycle.dispose();
  });

  it.each(["expiry", "replacement", "dispose"] as const)(
    "releases the insertion callback and action listener on feedback %s",
    (operation) => {
      const h = createHarness();
      const native = operation === "expiry" ? observeNativeFeedbackAnimations() : undefined;
      try {
        const manager = new InkbookFeedbackManager();
        let release = (): void => undefined;
        const undo = vi.fn(() => false);
        const handle = manager.showInPresentation(h.root as unknown as HTMLElement, {
          actions: [{ id: "undo-insertion", run: undo }],
          code: "handwriting-inserted",
          onClosed: () => release(),
          timeoutMs: 5_000,
        });
        const button = h.root.getElementsByTagName("button").item(0)!;
        const dismiss = vi.fn(() => handle.close());
        release = h.lifecycle.queueAutoActivation("drawing.svg", h.ownerWindow, vi.fn(), dismiss);
        if (operation === "replacement") {
          manager.showInPresentation(h.root as unknown as HTMLElement, {
            code: "drawing-load-failed",
          });
        } else if (operation === "dispose") manager.dispose();
        else {
          // Expiry starts the existing exit motion; its completion releases ownership.
          h.host.timer(5_000);
          expect(native?.animate).toHaveBeenCalledTimes(2);
          expect(native?.getAnimations).toHaveBeenCalled();
          expect(native?.animate).toHaveBeenLastCalledWith(
            expect.objectContaining({ scale: [1, 0] }),
            expect.objectContaining({ duration: 220 }),
          );
          expect(native?.animations[0]?.cancel).toHaveBeenCalled();
          expect(button.listeners.get("click")?.size).toBe(1);
          native?.animations[1]?.onfinish?.();
          expect(native?.animations[1]?.cancel).toHaveBeenCalled();
        }
        expect(button.listeners.get("click")?.size).toBe(0);
        button.dispatch("click");
        h.persistStroke("drawing.svg");
        expect(undo).not.toHaveBeenCalled();
        expect(dismiss).not.toHaveBeenCalled();
        handle.close("immediate");
        manager.dispose();
        h.lifecycle.dispose();
        expect(h.host.pendingTimers).toBe(0);
      } finally {
        native?.cleanup();
      }
    },
  );
});
