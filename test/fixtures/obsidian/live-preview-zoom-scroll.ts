import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { vi } from "vitest";
import {
  LIVE_PREVIEW_ZOOM_SCROLL_EXTENSION,
  LivePreviewZoomScrollBinding,
} from "../../../src/obsidian/embeds/live-preview-zoom-scroll";
import { FrameHarness } from "./navigation";
import { workSchedulerFromFrames } from "./work-scheduler";
import { createDiv } from "./active-controller";

type ZoomMeasureRequest = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;

export function createLivePreviewZoomScrollFixture(options?: { readonly nativeMaximum?: number }) {
  const parent = createDiv();
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "widget", extensions: LIVE_PREVIEW_ZOOM_SCROLL_EXTENSION }),
  });
  const root = createDiv();
  view.contentDOM.append(root);
  const frames = new FrameHarness();
  const requests = new Map<unknown, ZoomMeasureRequest>();
  const request = vi.spyOn(view, "requestMeasure").mockImplementation((measure) => {
    if (measure !== undefined) requests.set(measure.key, measure);
  });
  const binding = new LivePreviewZoomScrollBinding(
    view,
    root,
    workSchedulerFromFrames(frames.window),
  );
  let scrollTop = 0;
  const scrollWrite = vi.fn(
    (value: number) =>
      (scrollTop = Math.max(0, Math.min(options?.nativeMaximum ?? Infinity, value))),
  );
  Object.defineProperty(view.scrollDOM, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: scrollWrite,
  });
  const notify = (docChanged = false) => {
    for (const listener of view.state.facet(EditorView.updateListener)) {
      listener({ docChanged, view } as ViewUpdate);
    }
  };
  return {
    binding,
    view,
    frames,
    owner: view.scrollDOM,
    parent,
    root,
    request,
    scrollWrite,
    notify,
    measure: () => {
      const current = [...requests.values()];
      requests.clear();
      for (const measure of current) measure.write?.(measure.read(view), view);
    },
    destroy: () => {
      view.destroy();
      binding.dispose();
      parent.remove();
      request.mockRestore();
    },
  };
}
