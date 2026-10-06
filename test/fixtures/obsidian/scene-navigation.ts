import { vi, type Mock } from "vitest";
import { createInputState } from "../../../src/editor/input";
import { createControllerNavigation } from "../../../src/obsidian/embeds/active-editor/controller-interactions";
import type { ActiveEditorControllerOptions } from "../../../src/obsidian/embeds/active-editor/controller-types";
import { bindSceneScrollOwner } from "../../../src/obsidian/embeds/active-scene-runtime";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneToolCursor } from "../../../src/rendering/scene/tool-cursor";
import type { SceneViewport } from "../../../src/rendering/scene/types";
import type { FakeNode, FakeScheduler } from "../../unit/rendering/scene/fakes";
import { domRect } from "./active-editor";
import { workSchedulerFromFrames } from "./work-scheduler";

interface NavigationScene {
  readonly renderer: SvgSceneRenderer;
  readonly scheduler: FakeScheduler;
  readonly cursor: FakeNode;
  readonly layout: { readonly readViewport: Mock<() => SceneViewport> };
}

export function sceneNavigationFixture(
  scene: NavigationScene,
  cursorFrame: Extract<SceneToolCursor, { kind: "tool" }>,
) {
  const { renderer, scheduler, cursor, layout } = scene;
  let input = createInputState({ fitZoom: 0.1, zoom: 1 });
  let navigationFrame: FrameRequestCallback | undefined;
  const window = Object.assign(new EventTarget(), {
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      navigationFrame = callback;
      return 1;
    },
    cancelAnimationFrame: () => {
      navigationFrame = undefined;
    },
    getComputedStyle: () => ({}),
    innerWidth: 1000,
    innerHeight: 800,
  });
  const ownerDocument = { defaultView: window, scrollingElement: null };
  const owner = Object.assign(new EventTarget(), {
    ownerDocument,
    scrollTop: 200,
    scrollHeight: 10000,
    clientHeight: 800,
    getBoundingClientRect: () => domRect({ left: 0, top: 0, width: 1000, height: 800 }),
  });
  const bounds = { left: 0, top: 100, width: 1000, height: 2000 };
  const top = () => 300 - owner.scrollTop;
  const read = vi.fn(() => ({
    cursor: { ...cursorFrame, x: 250, y: 300 - top() },
    system: "crosshair",
  }));
  const navigation = createControllerNavigation({
    onCancelPinch: () => undefined,
    controller: {
      renderer,
      container: {
        ownerDocument,
        getBoundingClientRect: () => domRect({ ...bounds, top: top() }),
      },
      model: { page: {}, store: {} },
      workScheduler: workSchedulerFromFrames(window),
      selectionMoveLayout: { currentHeight: () => 2000 },
      applyZoomLayout: (update: { blockSize: number }) => {
        bounds.height = update.blockSize;
        renderer.invalidateLayout();
      },
    } as unknown as ActiveEditorControllerOptions,
    getInput: () => input,
    setInput: (next) => {
      input = next;
    },
    isSelectionMoveActive: () => false,
    renderSelection: () => {},
    scrollOwner: owner as unknown as BrowserScrollElement,
  });
  const binding = bindSceneScrollOwner(
    owner as unknown as BrowserScrollElement,
    window as unknown as Window,
    { root: { style: { setProperty: () => {} } } } as unknown as Parameters<
      typeof bindSceneScrollOwner
    >[2],
    renderer,
    { handleNativeScroll: () => navigation.notifyScroll() } as Parameters<
      typeof bindSceneScrollOwner
    >[4],
  );
  renderer.requestToolCursorFrame(read);
  scheduler.runAll();
  return {
    binding,
    renderer,
    scheduler,
    cursor,
    read: Object.assign(read, { layout }),
    navigation,
    top,
    owner,
    navigationFrame: () => navigationFrame!(16),
  };
}
