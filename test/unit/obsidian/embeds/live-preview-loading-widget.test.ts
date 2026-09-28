import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { InkbookLoadingPreviewWidget } from "../../../../src/obsidian/embeds/live-preview-loading-widget";
import { documentRecognitionUnavailable } from "../../../../src/obsidian/embeds/live-preview-recognition-effects";
import type { EmbedIntegrationPorts } from "../../../../src/obsidian/embeds/presentation-port";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { nativeFrameWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

function transientWidget(cached: false | undefined) {
  const host = new FakePresentationElement();
  let settle!: (value: false) => void;
  const pending = new Promise<false>((resolve) => {
    settle = resolve;
  });
  const cleanups = new Map<HTMLElement, () => void>();
  const ports = {
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
  return { widget, root, dispatch, settle };
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
    await Promise.resolve();
    h.widget.destroy(h.root);
    h.settle(false);
    await Promise.resolve();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
