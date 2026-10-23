import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { vi } from "vitest";
import {
  LIVE_PREVIEW_ZOOM_SCROLL_EXTENSION,
  LivePreviewZoomScrollBinding,
} from "../../../src/obsidian/embeds/live-preview/live-preview-zoom-scroll";
import { FrameHarness } from "./navigation";
import { workSchedulerFromFrames } from "./work-scheduler";
import { createDiv } from "./active-controller";

type ZoomMeasureRequest = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;

export const ZOOM_SCROLL_CANCELLATION_REASONS = [
  "wheel",
  "touchmove",
  "pointerdown",
  "keydown",
  "resize",
  "edit",
  "detach",
  "dispose",
] as const;

export function createLivePreviewZoomScrollFixture(options?: { readonly nativeMaximum?: number }) {
  const parent = createDiv();
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "widget", extensions: LIVE_PREVIEW_ZOOM_SCROLL_EXTENSION }),
  });
  const root = createDiv();
  view.contentDOM.append(root);
  const frames = new FrameHarness();
  const ownerWindow: Window = root.ownerDocument.defaultView!;
  let time = 0;
  let timerHandle = 0;
  const timers = new Map<number, { readonly due: number; readonly callback: () => void }>();
  const timerRequest = vi.spyOn(ownerWindow, "setTimeout").mockImplementation((callback, delay) => {
    if (typeof callback !== "function") throw new Error("Expected a timer callback.");
    const handle = ++timerHandle;
    timers.set(handle, { due: time + (delay ?? 0), callback: callback as () => void });
    return handle;
  });
  const timerCancel = vi.spyOn(ownerWindow, "clearTimeout").mockImplementation((handle) => {
    if (handle !== undefined) timers.delete(handle);
  });
  const requests = new Map<unknown, ZoomMeasureRequest>();
  const request = vi.spyOn(view, "requestMeasure").mockImplementation((measure) => {
    if (measure !== undefined) requests.set(measure.key, measure);
  });
  const scheduler = workSchedulerFromFrames(frames.window, { now: () => time });
  const binding = new LivePreviewZoomScrollBinding(view, root, scheduler);
  let scrollTop = 0;
  const scrollWrite = vi.fn(
    (value: number) =>
      (scrollTop = Math.max(0, Math.min(options?.nativeMaximum ?? Infinity, value))),
  );
  const scrollRead = vi.fn(() => scrollTop);
  Object.defineProperty(view.scrollDOM, "scrollTop", {
    configurable: true,
    get: scrollRead,
    set: scrollWrite,
  });
  const notify = (docChanged = false, geometryChanged = false, viewportChanged = false) => {
    for (const listener of view.state.facet(EditorView.updateListener)) {
      listener({ docChanged, geometryChanged, viewportChanged, view } as ViewUpdate);
    }
  };
  return {
    binding,
    view,
    frames,
    scheduler,
    owner: view.scrollDOM,
    parent,
    root,
    request,
    timerRequest,
    get pendingTimers() {
      return timers.size;
    },
    advance: (milliseconds: number) => {
      time += milliseconds;
      for (const [handle, timer] of [...timers]) {
        if (timer.due > time) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
    scrollWrite,
    scrollRead,
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
      timerRequest.mockRestore();
      timerCancel.mockRestore();
    },
  };
}

type ZoomScrollFixture = ReturnType<typeof createLivePreviewZoomScrollFixture>;

export function createLivePreviewZoomGeometryFixture(contentTop = 340) {
  const fixture = createLivePreviewZoomScrollFixture();
  const geometry = vi
    .spyOn(fixture.root, "getBoundingClientRect")
    .mockImplementation(() => new DOMRect(0, contentTop - fixture.owner.scrollTop, 800, 2_000));
  const destroy = fixture.destroy;
  return Object.assign(fixture, {
    geometry,
    destroy: () => {
      geometry.mockRestore();
      destroy();
    },
  });
}

export function retainMeasuredZoomTarget(fixture: ZoomScrollFixture, scrollTop: number): void {
  fixture.binding.retain(fixture.owner, scrollTop);
  fixture.measure();
  fixture.notify();
}

export function queueTrailingZoomTarget(fixture: ZoomScrollFixture): void {
  retainMeasuredZoomTarget(fixture, 800);
  fixture.binding.retain(fixture.owner, 1_000);
}

export function cancelZoomScrollForReason(
  fixture: ZoomScrollFixture,
  reason: (typeof ZOOM_SCROLL_CANCELLATION_REASONS)[number],
): void {
  if (reason === "edit") fixture.notify(true);
  else if (reason === "detach") fixture.root.remove();
  else if (reason === "dispose") fixture.binding.dispose();
  else {
    const target = reason === "keydown" ? document : reason === "resize" ? window : fixture.owner;
    target.dispatchEvent(new Event(reason));
  }
}
