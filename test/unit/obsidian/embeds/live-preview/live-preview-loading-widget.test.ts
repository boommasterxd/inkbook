import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { InkbookLoadingPreviewWidget } from "../../../../../src/obsidian/embeds/live-preview/live-preview-loading-widget";
import { documentRecognitionUnavailable } from "../../../../../src/obsidian/embeds/live-preview/live-preview-recognition-effects";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { nativeFrameWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import type { MotionPreference } from "../../../../../src/rendering/motion/transitions";

function transientWidget(cached: false | undefined) {
  const host = new FakePresentationElement();
  let settle!: (value: false) => void;
  const pending = new Promise<false>((resolve) => {
    settle = resolve;
  });
  const cleanups = new Map<HTMLElement, () => void>();
  const motionListeners = new Set<(motion: MotionPreference) => void>();
  const ports = {
    subscribeMotionPreference: (listener: (motion: MotionPreference) => void) => {
      motionListeners.add(listener);
      return () => motionListeners.delete(listener);
    },
    documents: { recognize: () => pending, cached: () => cached },
    sessions: { getMotionPreference: () => "reduced" },
    scheme: { subscribe: () => () => undefined },
    workScheduler: nativeFrameWorkScheduler,
    lifecycle: {
      register: (root: HTMLElement, cleanup: () => void) => {
        cleanups.set(root, cleanup);
        return cleanup;
      },
      dispose: (root: HTMLElement) => cleanups.get(root)?.(),
    },
  } as unknown as EmbedIntegrationPorts;
  const dispatch = vi.fn();
  const widget = new InkbookLoadingPreviewWidget("drawing.svg", ports, { presented: false });
  const root = widget.toDOM({ dom: host, dispatch } as unknown as EditorView);
  return { widget, root, dispatch, settle, motionListeners };
}

describe("loading widget transient recognition failure", () => {
  it("publishes an unavailable effect for an uncached failure", async () => {
    const h = transientWidget(undefined);
    await Promise.resolve();
    h.settle(false);
    await Promise.resolve();
    expect(h.dispatch).toHaveBeenCalledWith({
      effects: documentRecognitionUnavailable.of("drawing.svg"),
    });
    h.widget.destroy(h.root);
  });

  it("leaves cached terminal rejection to the recognition subscriber", async () => {
    const h = transientWidget(false);
    await Promise.resolve();
    h.settle(false);
    await Promise.resolve();
    expect(h.dispatch).not.toHaveBeenCalled();
    h.widget.destroy(h.root);
  });

  it("ignores transient completion after its widget was destroyed", async () => {
    const h = transientWidget(undefined);
    expect(h.motionListeners.size).toBe(1);
    for (const listener of h.motionListeners) listener("full");
    expect(h.root.dataset.inkbookMotion).toBe("full");
    for (const listener of h.motionListeners) listener("reduced");
    expect(h.root.dataset.inkbookMotion).toBe("reduced");
    const queuedListener = [...h.motionListeners][0]!;
    await Promise.resolve();
    h.widget.destroy(h.root);
    expect(h.motionListeners.size).toBe(0);
    queuedListener("full");
    expect(h.root.dataset.inkbookMotion).toBe("reduced");
    h.settle(false);
    await Promise.resolve();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
