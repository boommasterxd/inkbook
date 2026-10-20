import type { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceRuntimeLifecycle } from "../../../src/obsidian/embeds/workspace-runtime-lifecycle";
import { InkbookFeedbackManager } from "../../../src/obsidian/feedback";
import { TRANSITION_DURATIONS } from "../../../src/rendering/motion/transitions";
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
        h.host.timer(TRANSITION_DURATIONS.conditionalToolbarControl);
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
    },
  );
});
