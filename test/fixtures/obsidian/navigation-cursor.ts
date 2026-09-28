import type { NavigationCursorLayout } from "../../../src/obsidian/embeds/active-editor/navigation-layout";
import type { InputState } from "../../../src/editor/input";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneToolCursorFrame } from "../../../src/rendering/scene/tool-cursor";
import { domRect } from "./active-editor";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { workSchedulerFromFrames } from "./work-scheduler";
import { cursorPointerEvent, toolCursorHarness } from "./tool-cursor";

export function navigationCursorFixture(tool: InputState["activeTool"], pointerType: string) {
  const h = toolCursorHarness();
  const frames = new ManualFrameScheduler();
  const events: string[] = [];
  let scrollTop = 80;
  let frame: SceneToolCursorFrame | undefined;
  let projected: NavigationCursorLayout | undefined;
  const window = Object.assign(h.window, {
    innerHeight: 800,
    innerWidth: 1200,
    requestAnimationFrame: frames.requestAnimationFrame.bind(frames),
    cancelAnimationFrame: frames.cancelAnimationFrame.bind(frames),
  });
  const document = { defaultView: window, scrollingElement: null };
  const owner = {
    ownerDocument: document,
    clientHeight: 300,
    scrollHeight: 4000,
    getBoundingClientRect: () => {
      events.push("owner-box");
      return domRect({ left: 0, top: 40, width: 550, height: 300 });
    },
    get scrollTop() {
      events.push("scroll-read");
      return scrollTop;
    },
    set scrollTop(value: number) {
      events.push("scroll-write");
      const applied = Math.round(Math.max(0, Math.min(3700, value)) * 2) / 2;
      h.bounds.top += scrollTop - applied;
      scrollTop = applied;
    },
  } as unknown as BrowserScrollElement;
  h.measure.mockImplementation(() => {
    events.push("box");
    return domRect(h.bounds);
  });
  h.window.getComputedStyle.mockImplementation(() => {
    events.push("style");
    return {};
  });
  const fitZoom = h.bounds.width / OUTER_PAGE_WIDTH;
  h.controls.input = { ...h.controls.input, activeTool: tool, fitZoom, zoom: fitZoom };
  h.controller.record(cursorPointerEvent({ pointerType, pressure: 0.5 }), "move");
  const navigation = new ActiveEditorNavigation({
    workScheduler: workSchedulerFromFrames(frames),
    activePageHeight: () => 2000,
    container: {
      ownerDocument: document,
      getBoundingClientRect: h.measure,
    } as unknown as HTMLElement,
    scrollOwner: owner,
    renderer: {} as SvgSceneRenderer,
    getInput: () => h.controls.input,
    setInput: (input) => {
      h.controls.input = input;
    },
    applyZoomLayout: (update) => {
      events.push("height-write");
      // Model an active page-height transition retaining a different rendered height.
      h.bounds.height = update.blockSize + 17;
      return h.bounds.height;
    },
    applyCamera: (camera, layout) => {
      projected = layout;
      h.controls.cameraX = camera.x;
      if (layout !== undefined) h.controller.adoptNavigationLayout(layout);
      events.push("camera-write");
      frame = h.read(true);
    },
  });
  return { h, frames, events, navigation, frame: () => frame, projected: () => projected, owner };
}
