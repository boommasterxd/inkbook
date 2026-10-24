import { vi } from "vitest";

import { createInputState } from "../../../src/editor/input";
import { ActiveEditorLayout } from "../../../src/obsidian/embeds/active-editor/layout/layout";
import { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation/navigation";
import { readActiveSceneLayout } from "../../../src/obsidian/embeds/active-scene/active-scene-viewport";
import { PresentationController } from "../../../src/obsidian/embeds/presentation/presentation-controller";
import { ColorSchemeBroadcaster } from "../../../src/obsidian/theme/color-scheme";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling";
import { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneViewport } from "../../../src/rendering/scene/types";
import { page } from "../../integration/obsidian/embeds/active-editor/layout/active-editor-layout-fixture";
import { FakeSceneStore, FakeScheduler } from "../../unit/rendering/scene/fakes";
import { indexedStroke } from "../editor/stroke";
import { createIndexedSceneStore, createSceneRecord } from "../rendering/scene";
import { domRect } from "./active-editor";

/** Couples the real resize observer, layout, navigation and indexed scene boundaries. */
export function activeEditorResizePhaseFixture(frameDurationMs: number) {
  const events: string[] = [];
  const observers = resizeObservers();
  const scheduler = new FakeScheduler(frameDurationMs * 0.55);
  const { root, chromeHost, container, box, owner } = resizeDom(events);
  const scene = resizeScene({ container, root, owner }, scheduler, events, {
    readCamera: () => ({ x: navigation.cameraX, zoom: navigation.zoom }),
  });
  const { renderer, indexed, query } = scene;
  let input = createInputState();
  const navigation: ActiveEditorNavigation = new ActiveEditorNavigation({
    activePageHeight: () => layout.currentPageHeight() ?? 0,
    applyZoomLayout: (update) => layout.applyZoom(update),
    container,
    getInput: () => input,
    renderer,
    scrollOwner: owner,
    setInput: (next) => {
      input = next;
    },
    workScheduler: scheduler.workScheduler,
  });
  let maximumBottom: number | undefined;
  const layout: ActiveEditorLayout = new ActiveEditorLayout({
    chromeHost,
    container,
    onLayout: () => void events.push("layout-complete"),
    onReady: () => undefined,
    onResize: (update) => void navigation.applyResize(update),
    onZoom: (zoom) => navigation.setZoom(zoom),
    page,
    readResizeAnchor: (measurement) => navigation.readResizeAnchor(measurement),
    renderer,
    root,
    storeMaximumBottom: () => maximumBottom,
    workScheduler: scheduler.workScheduler,
  });
  const camera = observeResizeWrites(renderer, container, events);
  layout.chromeMounted();
  scheduler.runFrame();
  const initial = {
    cameraWrites: camera.mock.calls.length,
    containerReads: events.filter((event) => event === "container-read").length,
  };
  scheduler.time += frameDurationMs;
  scheduler.runAll();
  const reset = () => {
    clearResizeReads(scene, events);
    camera.mockClear();
  };
  reset();
  const presentation = presentationClampControl(
    { root, box, owner },
    scheduler,
    { changed: () => layout.contentChanged(), reset },
    frameDurationMs,
  );
  return {
    box,
    camera,
    container,
    events,
    indexed,
    initial,
    layout,
    navigation,
    owner,
    query,
    renderer,
    reset,
    scheduler,
    viewport: scene.viewport,
    sceneCamera: scene.camera,
    queuePresentationClamp: presentation.queue,
    mountPresentation: presentation.mount,
    setMaximumBottom: (value: number) => {
      maximumBottom = value;
      layout.contentChanged();
    },
    resize: (width: number) => {
      box.width = width;
      // SceneSurface registered first, matching actual ActiveScene construction.
      observers.deliver(container.firstElementChild!, width, 400);
      observers.deliver(root, width, 440);
    },
    frame: () => {
      scheduler.time += frameDurationMs;
      scheduler.runFrame();
    },
    release: () => {
      layout.dispose();
      navigation.dispose();
      renderer.destroy();
      presentation.release();
      owner.remove();
    },
  };
}

function presentationClampControl(
  dom: Pick<ReturnType<typeof resizeDom>, "root" | "box" | "owner">,
  scheduler: FakeScheduler,
  callbacks: { readonly changed: () => void; readonly reset: () => void },
  frameDurationMs: number,
) {
  let controller: PresentationController | undefined;
  const mount = () => {
    controller = mountClampedPresentation(dom.root, scheduler, frameDurationMs);
    scheduler.runAll();
    callbacks.changed();
    scheduler.runAll();
    callbacks.reset();
  };
  return {
    mount,
    queue: () => {
      dom.box.left = 100;
      dom.box.width = 600;
      Object.defineProperty(dom.owner, "clientWidth", { configurable: true, value: 400 });
      if (controller === undefined) {
        controller = mountClampedPresentation(dom.root, scheduler, frameDurationMs);
      } else window.dispatchEvent(new Event("resize"));
      callbacks.changed();
    },
    release: () => controller?.dispose(),
  };
}

function clearResizeReads(scene: ReturnType<typeof resizeScene>, events: string[]): void {
  events.length = 0;
  scene.query.mockClear();
  scene.indexed.work.indexedVisits = 0;
  scene.renderer.resetInstrumentation();
}

function observeResizeWrites(renderer: SvgSceneRenderer, container: HTMLElement, events: string[]) {
  const camera = vi.spyOn(renderer, "setCamera").mockImplementation((value) => {
    events.push("camera-write");
    SvgSceneRenderer.prototype.setCamera.call(renderer, value);
  });
  const setProperty = container.style.setProperty.bind(container.style);
  vi.spyOn(container.style, "setProperty").mockImplementation((name, value, priority) => {
    if (name === "block-size") events.push("height-write");
    setProperty(name, value, priority);
  });
  return camera;
}

function resizeDom(events: string[]) {
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.dataset["inkbookMotion"] = "reduced";
  const chromeHost = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const toolbar = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  toolbar.className = "inkbook-toolbar";
  const track = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  track.className = "inkbook-toolbar-track";
  toolbar.append(track);
  chromeHost.append(toolbar);
  const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.append(chromeHost, container);
  document.body.append(root);
  const box = { left: 20, top: 100, width: 1000 };
  const bounds = () => {
    const limit = Number.parseFloat(root.style.getPropertyValue("--inkbook-owner-inline-limit"));
    const width = Math.min(box.width, Number.isFinite(limit) ? limit : Infinity);
    return domRect({ ...box, width, height: Number.parseFloat(container.style.blockSize) || 0 });
  };
  vi.spyOn(root, "getBoundingClientRect").mockImplementation(bounds);
  vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => {
    events.push("container-read");
    return bounds();
  });
  Object.defineProperty(track, "scrollWidth", {
    get: () => {
      events.push("toolbar-read");
      return 550;
    },
  });
  const originalStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    if (element === container) events.push("style-read");
    return originalStyle(element);
  });
  let scrollTop = 200;
  const owner = scrollOwner(
    container,
    events,
    () => scrollTop,
    (value) => {
      box.top += scrollTop - value;
      scrollTop = value;
    },
  );
  document.body.append(owner);
  owner.append(root);
  return { root, chromeHost, container, box, owner };
}

function mountClampedPresentation(
  root: HTMLElement,
  scheduler: FakeScheduler,
  frameDurationMs: number,
) {
  const presentation = new PresentationController(
    {
      attachmentGeneration: 1,
      attachmentId: "resize-clamp",
      documentId: "drawings/ink.svg",
      embedReference: {
        documentId: "drawings/ink.svg",
        from: 4,
        kind: "live-preview",
        sourcePath: "notes/note.md",
        to: 28,
      },
      root,
    },
    { activate: () => undefined, detach: () => undefined, mount: () => undefined },
    new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    undefined,
    scheduler.workScheduler,
  );
  presentation.mount();
  scheduler.time += frameDurationMs;
  scheduler.runFrame();
  return presentation;
}

function resizeScene(
  dom: Pick<ReturnType<typeof resizeDom>, "container" | "root" | "owner">,
  scheduler: FakeScheduler,
  events: string[],
  layout: {
    readonly readCamera: () => { readonly x: number; readonly zoom: number };
  },
) {
  const { container, root, owner } = dom;
  const records = new FakeSceneStore();
  for (let rank = 0; rank < 10_000; rank += 1) {
    const stroke = indexedStroke(rank);
    const y = rank * 100;
    records.records.set(
      stroke.id,
      createSceneRecord({ ...stroke, pivot: { x: 20, y }, points: [20, y, 0.5] }, rank),
    );
  }
  const indexed = createIndexedSceneStore(records);
  const query = vi.spyOn(indexed.store, "beginQuery");
  let viewport: SceneViewport | undefined;
  let camera: ReturnType<typeof layout.readCamera> | undefined;
  const renderer = new SvgSceneRenderer({
    container,
    layout: {
      readViewport: () => {
        events.push("scene-read");
        camera = layout.readCamera();
        viewport = readActiveSceneLayout(container, owner, root).viewport;
        events.push("scene-end");
        return viewport;
      },
    },
    page: page(),
    reducedMotion: true,
    store: indexed.store,
    surfaceThemeRoot: root,
    workScheduler: scheduler.workScheduler,
  });
  return { renderer, indexed, query, viewport: () => viewport, camera: () => camera };
}

function resizeObservers() {
  const callbacks = new Map<Element, ResizeObserverCallback>();
  vi.spyOn(window, "ResizeObserver").mockImplementation(
    class {
      public constructor(private readonly callback: ResizeObserverCallback) {}
      public observe(target: Element): void {
        callbacks.set(target, this.callback);
      }
      public unobserve(target: Element): void {
        callbacks.delete(target);
      }
      public disconnect(): void {
        for (const [target, callback] of callbacks) {
          if (callback === this.callback) callbacks.delete(target);
        }
      }
    },
  );
  return {
    deliver: (target: Element, width: number, height: number) =>
      callbacks.get(target)?.(
        [
          {
            target,
            contentRect: domRect({ width, height, left: 0, top: 0 }),
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
  };
}

function scrollOwner(
  container: HTMLElement,
  events: string[],
  readScroll: () => number,
  writeScroll: (value: number) => void,
): HTMLElement & BrowserScrollElement {
  const owner = container.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const style = container.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.textContent = ".resize-phase-owner { overflow-y: auto; }";
  owner.className = "resize-phase-owner";
  owner.append(style);
  Object.defineProperties(owner, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: {
      get: () => {
        events.push("owner-height-read");
        return 500;
      },
    },
    scrollHeight: {
      get: () => {
        events.push("scroll-height-read");
        return 5000;
      },
    },
    scrollTop: {
      get: () => {
        events.push("scroll-read");
        return readScroll();
      },
      set: (value: number) => {
        events.push("scroll-write");
        writeScroll(value);
      },
    },
  });
  vi.spyOn(owner, "getBoundingClientRect").mockImplementation(() => {
    events.push("owner-read");
    return domRect({ left: 0, top: 0, width: owner.clientWidth, height: 500 });
  });
  return owner;
}
