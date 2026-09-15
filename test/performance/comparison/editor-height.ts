import { expect } from "vitest";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import { FakeClassList } from "../../fixtures/obsidian/class-list";
import { bottomMarker, createPageHeightStore } from "../editor/page-height-performance-fixture";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";

const ANIMATION_FILE = "test/performance/editor/page-height-animation.test.ts";
const HEIGHT_MODULE = "obsidian/embeds/active-editor/height-transition";
const SCROLL_MODULE = "obsidian/embeds/transition-scroll-stability";
const LAYOUT_MODULE = "obsidian/embeds/active-editor/layout";
const STORE_MODULE = "domain/store/public";

const HEIGHT_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "editor.height.animation-frames",
    modules: [HEIGHT_MODULE, "rendering/motion/transitions"],
    covers: [{ file: ANIMATION_FILE, test: "growth and shrink animation frames", ordinals: [1] }],
    execution: "sync",
    statistics: [
      {
        kind: "p99",
        estimator: "upper-rank",
        population: "samples",
        minimumSamples: 100,
        minimumOperations: 500,
      },
    ],
    warmupOperations: 20,
    create: animationKernel,
  },
  {
    id: "editor.height.scroll-anchoring",
    modules: [SCROLL_MODULE],
    covers: [
      { file: ANIMATION_FILE, test: "visual scroll anchoring constant-time", ordinals: [1] },
    ],
    execution: "sync",
    statistics: [
      { kind: "p99", estimator: "upper-rank", population: "samples", minimumSamples: 600 },
    ],
    warmupOperations: 20,
    create: scrollKernel,
  },
  {
    id: "editor.height.layout-observer",
    modules: [LAYOUT_MODULE],
    covers: [{ file: ANIMATION_FILE, test: "root-height animation", ordinals: [1] }],
    execution: "sync",
    statistics: [
      { kind: "p99", estimator: "upper-rank", population: "samples", minimumSamples: 600 },
    ],
    warmupOperations: 20,
    create: layoutKernel,
  },
  {
    id: "editor.height.bottom-extent",
    modules: [STORE_MODULE],
    covers: [
      {
        file: "test/performance/editor/page-height-mutation.test.ts",
        test: "updates a 10,000-stroke bottom extent without scanning the store",
        ordinals: [1],
      },
    ],
    execution: "sync",
    statistics: [
      { kind: "p99", estimator: "upper-rank", population: "samples", minimumSamples: 500 },
    ],
    warmupOperations: 20,
    create: mutationKernel,
  },
];

function frameQueue(refreshRate: number) {
  const frames = new Map<number, FrameRequestCallback>();
  let identity = 0;
  let time = 0;
  const ownerWindow = {
    cancelAnimationFrame: (id: number) => void frames.delete(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++identity, callback);
      return identity;
    },
  };
  return {
    ownerWindow,
    get size() {
      return frames.size;
    },
    resetTime: () => {
      time = 0;
    },
    flush: () => {
      const first = frames.entries().next().value;
      if (first === undefined) throw new Error("A height frame must be pending.");
      frames.delete(first[0]);
      first[1](time);
      time += 1_000 / refreshRate;
    },
  };
}

function animationKernel(
  implementation: ComparisonImplementation,
  refreshRate: number,
): ComparisonKernel {
  const { ActiveHeightTransition } =
    implementation.get<
      typeof import("../../../src/obsidian/embeds/active-editor/height-transition")
    >(HEIGHT_MODULE);
  const { TRANSITION_DURATIONS } = implementation.get<
    typeof import("../../../src/rendering/motion/transitions")
  >("rendering/motion/transitions");
  const queue = frameQueue(refreshRate);
  const container = {
    classList: new FakeClassList(),
    style: { removeProperty: () => "", setProperty: () => undefined },
  } as unknown as HTMLElement;
  const transition = new ActiveHeightTransition(container, queue.ownerWindow as unknown as Window);
  let operation = 0;
  let completed = false;
  let samples: number[] = [];
  const maximumFrames =
    Math.ceil(TRANSITION_DURATIONS.automaticPageGrowth / (1_000 / refreshRate)) + 2;
  return {
    reset: () => {
      completed = false;
      samples = [];
      queue.resetTime();
      const grows = operation % 2 === 0;
      transition.begin({
        applyFrame: () => undefined,
        applySurfaceTarget: () => undefined,
        currentRenderedHeight: grows ? 480 : 720,
        targetRenderedHeight: grows ? 720 : 480,
        sceneCommitPending: () => false,
        stabilizeScroll: operation % 4 < 2,
        onComplete: () => {
          completed = true;
        },
      });
      operation += 1;
    },
    run: () => {
      while (queue.size > 0 && samples.length <= maximumFrames) {
        const started = performance.now();
        queue.flush();
        samples.push(performance.now() - started);
      }
    },
    measurementSamples: () => samples,
    verify: () => {
      expect(completed).toBe(true);
      expect(transition.active).toBe(false);
      expect(queue.size).toBe(0);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.length).toBeLessThanOrEqual(maximumFrames);
    },
    dispose: () => transition.cancel(),
  };
}

function scrollKernel(
  implementation: ComparisonImplementation,
  refreshRate: number,
): ComparisonKernel {
  const { TransitionScrollStability } =
    implementation.get<typeof import("../../../src/obsidian/embeds/transition-scroll-stability")>(
      SCROLL_MODULE,
    );
  const queue = frameQueue(refreshRate);
  const owner = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    classList: new FakeClassList(),
    clientHeight: 800,
    scrollHeight: 10_000,
    scrollTop: 1_200,
    ownerDocument: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      scrollingElement: null,
    },
  } as unknown as BrowserScrollElement;
  const root = {
    classList: new FakeClassList(),
    getBoundingClientRect: () => ({ top: 2_000 - owner.scrollTop }),
  } as unknown as HTMLElement;
  const stability = new TransitionScrollStability({
    owner: () => owner,
    ownerWindow: queue.ownerWindow as unknown as Window,
    root,
  });
  const release = stability.begin();
  let operation = 0;
  return {
    reset: () => {
      owner.scrollTop = operation++ % 2 === 0 ? 1_204 : 1_200;
    },
    run: () => queue.flush(),
    verify: () => {
      expect(owner.scrollTop).toBe(1_200);
    },
    dispose: () => {
      release();
      stability.dispose();
    },
  };
}

async function mutationKernel(implementation: ComparisonImplementation): Promise<ComparisonKernel> {
  const { ElementStore } =
    implementation.get<typeof import("../../../src/domain/store/public")>(STORE_MODULE);
  const store = await createPageHeightStore(ElementStore);
  const baseline = store.getMaximumBottom();
  if (baseline === undefined) throw new Error("The bottom-extent store must have content.");
  let operation = 0;
  let marker = bottomMarker(operation, baseline + 1_000);
  let createdBottom: number | undefined;
  let removedBottom: number | undefined;
  let markerBottom: number | undefined;
  let samples: number[] = [];
  return {
    reset: () => {
      marker = bottomMarker(operation++, baseline + 1_000);
      samples = [];
    },
    run: () => {
      let started = performance.now();
      store.create(marker);
      createdBottom = store.getMaximumBottom();
      markerBottom = store.get(marker.id)?.bounds.maxY;
      samples.push(performance.now() - started);
      started = performance.now();
      store.remove([marker.id]);
      removedBottom = store.getMaximumBottom();
      samples.push(performance.now() - started);
    },
    measurementSamples: () => samples,
    verify: () => {
      expect(createdBottom).toBe(markerBottom);
      expect(createdBottom).toBeGreaterThan(baseline);
      expect(removedBottom).toBe(baseline);
      expect(store.instrumentation.fullStoreScans).toBe(0);
    },
    dispose: () => {
      store.remove([marker.id]);
    },
  };
}

function layoutKernel(
  implementation: ComparisonImplementation,
  refreshRate: number,
): ComparisonKernel {
  const { ActiveEditorLayout } =
    implementation.get<typeof import("../../../src/obsidian/embeds/active-editor/layout")>(
      LAYOUT_MODULE,
    );
  const fixture = layoutSurface(refreshRate);
  let layoutCalls = 0;
  const layout = new ActiveEditorLayout({
    chromeHost: fixture.chromeHost,
    container: fixture.container,
    root: fixture.root,
    onLayout: () => {
      layoutCalls += 1;
    },
    onReady: () => undefined,
    onZoom: () => undefined,
    page: () => ({
      activeBufferLines: 3,
      background: { type: "squares", spacing: 50 },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    }),
    renderer: {
      hasPendingSceneCommit: false,
      invalidateLayout: () => undefined,
      setCamera: () => undefined,
      setPage: () => undefined,
    } as unknown as SvgSceneRenderer,
    storeMaximumBottom: () => undefined,
  });
  layout.chromeMounted();
  fixture.resize(200);
  fixture.flush();
  layoutCalls = 0;
  const initialReads = fixture.toolbarReads();
  let frame = 0;
  let height = 200;
  return {
    reset: () => {
      height = 200 + 100 * Math.sin((frame++ * (1_000 / refreshRate)) / 240);
    },
    run: () => {
      fixture.resize(height);
      fixture.flush();
    },
    verify: () => {
      expect(fixture.toolbarReads()).toBe(initialReads);
      expect(layoutCalls).toBe(0);
    },
    dispose: () => layout.dispose(),
  };
}

function layoutSurface(refreshRate: number) {
  const queue = frameQueue(refreshRate);
  let resizeCallback: ResizeObserverCallback | undefined;
  let reads = 0;
  const track = {
    get scrollWidth() {
      reads += 1;
      return 554;
    },
  };
  const toolbar = { querySelector: () => track, scrollWidth: 570 };
  const chromeHost = { querySelector: () => toolbar } as unknown as HTMLElement;
  const ownerWindow = {
    ...queue.ownerWindow,
    ResizeObserver: class {
      public constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      public observe(): void {}
      public unobserve(): void {}
      public disconnect(): void {}
    },
    getComputedStyle: () => ({
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      borderRightWidth: "0px",
      borderTopWidth: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      paddingRight: "0px",
      paddingTop: "0px",
    }),
  };
  const ownerDocument = { defaultView: ownerWindow } as unknown as Document;
  const root = { ownerDocument } as unknown as HTMLElement;
  const style = { blockSize: "0px", removeProperty: () => "", setProperty: () => undefined };
  const container = {
    classList: new FakeClassList(),
    ownerDocument,
    style,
    getBoundingClientRect: () => new DOMRect(0, 0, 700, Number.parseFloat(style.blockSize)),
  } as unknown as HTMLElement;
  return {
    chromeHost,
    container,
    root,
    toolbarReads: () => reads,
    resize: (height: number) => {
      const size = [{ inlineSize: 700, blockSize: height }];
      resizeCallback?.(
        [
          {
            target: root,
            contentBoxSize: size,
            borderBoxSize: size,
            devicePixelContentBoxSize: size,
            contentRect: new DOMRect(0, 0, 700, height),
          },
        ],
        {} as ResizeObserver,
      );
    },
    flush: () => {
      let count = 0;
      while (queue.size > 0 && count++ < 1_000) queue.flush();
      if (queue.size > 0) throw new Error("The layout fixture did not settle.");
    },
  };
}

export { HEIGHT_SCENARIOS as heightScenarios };
