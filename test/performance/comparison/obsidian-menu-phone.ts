import { measureInteractionSequence } from "../interaction-refresh-profile";
import { installPhoneSheetViewport } from "../../fixtures/obsidian/phone-sheet-viewport";
import { Platform, Keymap } from "obsidian";
import { expect, vi } from "vitest";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { ManualFrameScheduler } from "../../fixtures/obsidian/manual-frame-scheduler";
import type { ComparisonScenario } from "./contracts";

function touch(type: string, clientY: number, timeStamp: number): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    clientY,
    pointerId: 1,
    pointerType: "touch",
  });
  Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  return event;
}

function frameBoundary() {
  const frames = new ManualFrameScheduler();
  const request = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
  const cancel = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
  const boundary = {
    frames,
    activate() {
      window.requestAnimationFrame = (callback) => frames.requestAnimationFrame(callback);
      window.cancelAnimationFrame = (handle) => frames.cancelAnimationFrame(handle);
    },
    dispose() {
      if (request) Object.defineProperty(window, "requestAnimationFrame", request);
      else Reflect.deleteProperty(window, "requestAnimationFrame");
      if (cancel) Object.defineProperty(window, "cancelAnimationFrame", cancel);
      else Reflect.deleteProperty(window, "cancelAnimationFrame");
    },
  };
  boundary.activate();
  return boundary;
}

/** Each interleaved swipe owns its RAF queue rather than replacing the global window. */
function swipeFrameBoundary() {
  const frames = new ManualFrameScheduler();
  const ownerWindow = {
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      frames.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle: number) => frames.cancelAnimationFrame(handle),
    getComputedStyle: window.getComputedStyle.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  } as unknown as Window;
  return { frames, ownerWindow, dispose() {} };
}

export const PHONE_MENU_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "obsidian-phone-sheet-swipe",
    modules: ["obsidian/menus/phone-sheet-swipe"],
    covers: [
      {
        file: "test/performance/obsidian/phone-sheet-swipe-performance.test.ts",
        test: "coalesces continuous touch input without repeated layout reads",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation) {
      const { PhoneSheetSwipeController } = implementation.get<
        typeof import("../../../src/obsidian/menus/phone-sheet-swipe")
      >("obsidian/menus/phone-sheet-swipe");
      installObsidianDomHelpers();
      const surface = window.createEl("section");
      const backdrop = window.createDiv();
      const handle = surface.createDiv({ cls: "inkbook-adaptive-panel-drag-region" });
      const scroll = window.createDiv();
      let reads = 0;
      let dragWrites = 0;
      let inheritedWrites = 0;
      surface.getBoundingClientRect = () => {
        reads += 1;
        return new DOMRect(0, 0, 300, 200);
      };
      const originalSet = surface.style.setProperty.bind(surface.style);
      surface.style.setProperty = (property, value, priority) => {
        if (property === "translate") dragWrites += 1;
        if (property.startsWith("--")) inheritedWrites += 1;
        originalSet(property, value, priority);
      };
      let boundary: ReturnType<typeof swipeFrameBoundary> | undefined;
      let controller: InstanceType<typeof PhoneSheetSwipeController> | undefined;
      let samples: number[] = [];
      let maximumPending = 0;
      const cleanup = () => {
        if (controller) {
          surface.removeEventListener("pointerdown", controller.handlePointerDown);
          surface.removeEventListener("pointermove", controller.handlePointerMove);
          controller.dispose();
          controller = undefined;
        }
        boundary?.dispose();
        boundary = undefined;
        surface.remove();
        backdrop.remove();
      };
      return {
        reset() {
          cleanup();
          boundary = swipeFrameBoundary();
          samples = [];
          maximumPending = 0;
          document.body.append(backdrop, surface);
          controller = new PhoneSheetSwipeController({
            backdrop,
            close: () => undefined,
            durationMs: 0,
            ownerWindow: boundary.ownerWindow,
            scroll,
            surface,
          });
          surface.addEventListener("pointerdown", controller.handlePointerDown);
          surface.addEventListener("pointermove", controller.handlePointerMove);
          reads = 0;
          dragWrites = 0;
          inheritedWrites = 0;
          handle.dispatchEvent(touch("pointerdown", 10, 0));
        },
        *run() {
          return yield* measureInteractionSequence(
            (frame) => {
              surface.dispatchEvent(touch("pointermove", 10 + frame * 2, frame + 1));
              surface.dispatchEvent(touch("pointermove", 11 + frame * 2, frame + 2));
              surface.dispatchEvent(touch("pointermove", 12 + frame * 2, frame + 3));
              maximumPending = Math.max(maximumPending, boundary!.frames.pendingCount);
              boundary!.frames.runNext();
            },
            600,
            samples,
          );
        },
        measurementSamples() {
          return samples;
        },
        verify() {
          expect(maximumPending).toBe(1);
          expect(reads).toBe(1);
          expect(dragWrites).toBe(600);
          expect(inheritedWrites).toBe(0);
          expect(boundary!.frames.pendingCount).toBe(0);
          expect(surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe("");
          cleanup();
        },
        dispose: cleanup,
      };
    },
  },
  {
    id: "obsidian-phone-sheet-editable",
    modules: ["obsidian/menus/adaptive-panel"],
    covers: [
      {
        file: "test/performance/obsidian/phone-sheet-editable-performance.test.ts",
        test: "coalesces viewport correction with two geometry reads",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation) {
      const { AdaptivePanelSession } = implementation.get<
        typeof import("../../../src/obsidian/menus/adaptive-panel")
      >("obsidian/menus/adaptive-panel");
      installObsidianDomHelpers();
      let fixture: ReturnType<typeof editableFixture> | undefined;
      let samples: number[] = [];
      return {
        reset() {
          fixture?.dispose();
          fixture = editableFixture(AdaptivePanelSession);
          samples = [];
        },
        *run() {
          for (let frame = 0; frame < 600; frame += 1) {
            fixture!.activate();
            try {
              const started = performance.now();
              fixture!.run();
              samples.push(performance.now() - started);
            } finally {
              fixture!.deactivate();
            }
            yield;
          }
          return samples;
        },
        measurementSamples() {
          return samples;
        },
        verify() {
          fixture!.verify();
        },
        dispose() {
          fixture?.dispose();
          fixture = undefined;
        },
      };
    },
  },
];

function editableFixture(
  sessionClass: typeof import("../../../src/obsidian/menus/adaptive-panel").AdaptivePanelSession,
) {
  const oldPhone = Platform.isPhone;
  Platform.isPhone = true;
  const boundary = frameBoundary();
  const viewportBoundary = installPhoneSheetViewport();
  const { viewport } = viewportBoundary;
  const inset = keyboardInset();
  const root = window.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "reduced";
  root.dataset.inkbookKeyboardNavigation = "false";
  const anchor = root.createEl("button");
  const canvas = root.createDiv();
  const input = window.createEl("input");
  anchor.getBoundingClientRect = () => new DOMRect(300, 100, 44, 44);
  document.body.append(root);
  const session = new sessionClass({
    anchor,
    canvasInputSurface: canvas,
    createContent: () => {
      const fragment = window.createFragment();
      fragment.append(input);
      return fragment;
    },
    keymap: new Keymap(),
    kind: "style",
    label: "Style",
    onClosed: () => undefined,
    ownerDocument: document,
    ownerWindow: window,
    renderIcon: (element, icon) => element.setAttribute("data-icon", icon),
  });
  boundary.frames.runNext(0);
  input.focus();
  const scroll = input.closest<HTMLElement>(".inkbook-adaptive-panel-scroll")!;
  let scrollReads = 0;
  let inputReads = 0;
  let allFramesPendingOne = true;
  scroll.getBoundingClientRect = () => {
    scrollReads += 1;
    return new DOMRect(0, 300, 360, 200);
  };
  input.getBoundingClientRect = () => {
    inputReads += 1;
    return new DOMRect(0, 530, 100, 30);
  };
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  const layer = input.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
  const layerParent = layer.parentElement!;
  const activeDescriptor = Object.getOwnPropertyDescriptor(document, "activeElement");
  const deactivate = () => {
    layer.remove();
    boundary.dispose();
    viewportBoundary.restore();
    Platform.isPhone = oldPhone;
    if (activeDescriptor) Object.defineProperty(document, "activeElement", activeDescriptor);
    else Reflect.deleteProperty(document, "activeElement");
  };
  const activate = () => {
    layerParent.append(layer);
    boundary.activate();
    Platform.isPhone = true;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => input });
  };
  inset.dispose();
  deactivate();
  return {
    activate,
    deactivate,
    run() {
      scroll.scrollTop = 100;
      for (let event = 0; event < 3; event += 1) {
        viewport.dispatchEvent(new Event("resize"));
        inset.resize(350);
      }
      allFramesPendingOne &&= boundary.frames.pendingCount === 1;
      boundary.frames.runNext(0);
    },
    verify() {
      expect(allFramesPendingOne).toBe(true);
      expect(inputReads).toBe(600);
      expect(scrollReads).toBe(600);
      expect(boundary.frames.pendingCount).toBe(0);
    },
    dispose() {
      activate();
      try {
        session.close("immediate");
        root.remove();
      } finally {
        deactivate();
      }
    },
  };
}

function keyboardInset() {
  let probe: Element | undefined;
  let notify: (() => void) | undefined;
  const observer = vi.spyOn(window, "ResizeObserver").mockImplementation(
    class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        if (!target.classList.contains("inkbook-phone-keyboard-inset")) return;
        probe = target;
        notify = () => this.callback([], this);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  return {
    resize(height: number) {
      if (!probe || !notify) throw new Error("No keyboard inset observer.");
      Object.defineProperty(probe, "offsetHeight", { configurable: true, value: height });
      notify();
    },
    dispose() {
      observer.mockRestore();
    },
  };
}
