import { assert } from "vitest";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import { createPresentationMotionWindow } from "../../fixtures/obsidian/presentation-motion-window";
import type { ComparisonScenario } from "./contracts";

function measureFrames(
  clock: { frames: ReadonlyMap<number, FrameRequestCallback>; frame(time: number): void },
  refreshRate: number,
  early = false,
): number[] {
  const samples: number[] = [];
  const frameDuration = 1000 / refreshRate;
  const frameBound = Math.ceil(180 / frameDuration) + 2;
  let frames = 0;
  while (clock.frames.size > 0 && frames <= frameBound) {
    assert.strictEqual(clock.frames.size, 1);
    const started = performance.now();
    clock.frame(frames * frameDuration);
    samples.push(performance.now() - started);
    frames += 1;
    if (early && frames === 3) break;
  }
  assert.ok(frames <= frameBound);
  return samples;
}

const revealScenarios: ComparisonScenario[] = ["preview", "editor"].map((target) => ({
  id: `obsidian-presentation-reveal-${target}`,
  modules: ["obsidian/embeds/presentation-entrance"],
  covers: [
    {
      file: "test/performance/obsidian/presentation-entrance-performance.test.ts",
      test: `Hz ${target} reveal frames below one millisecond`,
      ordinals: [1],
    },
  ],
  statistics: [
    {
      kind: "p99",
      estimator: "upper-rank",
      population: "samples",
      minimumSamples: 100,
      minimumOperations: 2,
    },
  ],
  execution: "async",

  warmupOperations: 20,
  create(implementation, refreshRate) {
    const { PresentationEntrance } = implementation.get<
      typeof import("../../../src/obsidian/embeds/presentation-entrance")
    >("obsidian/embeds/presentation-entrance");
    const clock = createPresentationMotionWindow();
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    const preview = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    root.append(preview);
    preview.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    let entrance: InstanceType<typeof PresentationEntrance>;
    let presented = 0;
    let iteration = 0;
    let samples: number[] = [];
    return {
      reset() {
        presented = 0;
        entrance = new PresentationEntrance({
          motion: () => "system",
          onPresented: () => {
            presented += 1;
          },
          ownerWindow: clock.ownerWindow,
          preview,
          root,
          state: { presented: false, initialHeight: iteration++ % 2 === 0 ? 48 : 0 },
        });
        entrance.prepare();
        if (target === "editor") entrance.holdForActivation();
        entrance.measure();
        if (target === "editor") {
          assert.strictEqual(clock.frames.size, 0);
          assert.strictEqual(entrance.revealActive(800), true);
        }
      },
      async run() {
        samples = measureFrames(clock, refreshRate);
        return entrance.ready;
      },
      verify(result) {
        assert.strictEqual(result, true);
        assert.strictEqual(entrance.pending, false);
        assert.strictEqual(presented, 1);
        assert.strictEqual(clock.frames.size, 0);
        assert.strictEqual(clock.listeners.size, 0);
      },
      measurementSamples: () => samples,
      dispose() {
        entrance?.dispose();
        root.remove();
      },
    };
  },
}));

const loadingScenarios: ComparisonScenario[] = [false, true].map((early) => ({
  id: `obsidian-loading-motion-${early ? "early" : "complete"}`,
  modules: [
    "obsidian/embeds/loading-placeholder",
    "obsidian/theme/color-scheme",
    "obsidian/embeds/presentation-entrance",
  ],
  covers: [
    {
      file: "test/performance/obsidian/presentation-entrance-performance.test.ts",
      test: `(early=${String(early)})`,
      ordinals: [1],
    },
  ],
  statistics: [
    { kind: "p99", estimator: "upper-rank", population: "samples", minimumSamples: 100 },
  ],
  execution: "sync",

  warmupOperations: 20,
  create(implementation, refreshRate) {
    const { createLoadingPlaceholder } = implementation.get<
      typeof import("../../../src/obsidian/embeds/loading-placeholder")
    >("obsidian/embeds/loading-placeholder");
    const { ColorSchemeBroadcaster } = implementation.get<
      typeof import("../../../src/obsidian/theme/color-scheme")
    >("obsidian/theme/color-scheme");
    const { PresentationEntrance } = implementation.get<
      typeof import("../../../src/obsidian/embeds/presentation-entrance")
    >("obsidian/embeds/presentation-entrance");
    const host = new FakePresentationElement();
    const ownerWindow = host.ownerDocument.defaultView;
    assert.ok(ownerWindow);
    const clock = createPresentationMotionWindow();
    const timers = new Set<number>();
    let nextTimer = 0;
    Object.assign(ownerWindow, {
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        clock.ownerWindow.requestAnimationFrame(callback),
      cancelAnimationFrame: (id: number) => clock.ownerWindow.cancelAnimationFrame(id),
      setTimeout: () => {
        timers.add(++nextTimer);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    });
    const scheme = new ColorSchemeBroadcaster({ getColorScheme: () => "light" });
    let loading: ReturnType<typeof createLoadingPlaceholder>;
    let samples: number[] = [];
    let height = 0;
    return {
      reset() {
        loading = createLoadingPlaceholder(host as unknown as HTMLElement, {
          motion: "system",
          scheme,
        });
        assert.strictEqual(loading.renderedHeight, 0);
      },
      run() {
        samples = measureFrames(clock, refreshRate, early);
        height = loading.renderedHeight;
        const started = performance.now();
        loading.dispose();
        samples.push(performance.now() - started);
      },
      verify() {
        if (early) {
          assert.ok(height > 0);
          assert.ok(height < 48);
        } else assert.strictEqual(height, 48);
        assert.strictEqual(loading.renderedHeight, height);
        assert.strictEqual(clock.frames.size, 0);
        assert.strictEqual(timers.size, 0);
        verifyHandoffHeight(PresentationEntrance, height);
      },
      measurementSamples: () => samples,
      dispose() {
        loading?.dispose();
      },
    };
  },
}));

const exitScenario: ComparisonScenario = {
  id: "obsidian-presentation-exit",
  modules: ["obsidian/embeds/presentation-exit"],
  covers: [
    {
      file: "test/performance/obsidian/presentation-entrance-performance.test.ts",
      test: "Hz exit frames below one millisecond",
      ordinals: [1],
    },
  ],
  statistics: [
    { kind: "p99", estimator: "upper-rank", population: "samples", minimumSamples: 100 },
  ],
  execution: "async",

  warmupOperations: 20,
  create(implementation, refreshRate) {
    const { PresentationExit } = implementation.get<
      typeof import("../../../src/obsidian/embeds/presentation-exit")
    >("obsidian/embeds/presentation-exit");
    const clock = createPresentationMotionWindow();
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    root.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    let exit: InstanceType<typeof PresentationExit>;
    let ready = Promise.resolve(false);
    let samples: number[] = [];
    return {
      reset() {
        exit = new PresentationExit(
          root,
          clock.ownerWindow,
          () => "system",
          () => ({ before: 24, after: 24 }),
        );
        ready = exit.begin();
      },
      async run() {
        samples = measureFrames(clock, refreshRate);
        return ready;
      },
      verify(result) {
        assert.strictEqual(result, true);
        assert.strictEqual(
          Number.parseFloat(root.style.getPropertyValue("--inkbook-presentation-block-size")),
          0,
        );
        assert.strictEqual(clock.frames.size, 0);
        exit.dispose();
        assert.strictEqual(clock.listeners.size, 0);
      },
      measurementSamples: () => samples,
      dispose() {
        exit?.dispose();
        root.remove();
      },
    };
  },
};

export const OBSIDIAN_EMBED_MOTION_SCENARIOS: readonly ComparisonScenario[] = [
  ...revealScenarios,
  ...loadingScenarios,
  exitScenario,
];

function verifyHandoffHeight(
  entranceConstructor: typeof import("../../../src/obsidian/embeds/presentation-entrance").PresentationEntrance,
  height: number,
): void {
  const previewClock = createPresentationMotionWindow();
  const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  const preview = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  root.append(preview);
  const entrance = new entranceConstructor({
    motion: () => "system",
    onPresented: () => undefined,
    ownerWindow: previewClock.ownerWindow,
    preview,
    root,
    state: { presented: false, initialHeight: height },
  });
  entrance.prepare();
  assert.strictEqual(
    Number.parseFloat(root.style.getPropertyValue("--inkbook-presentation-block-size")),
    height,
  );
  entrance.dispose();
}
