import { assert } from "vitest";
import { recognitionCacheFixture } from "../../fixtures/obsidian/recognition-cache";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import type { ComparisonScenario } from "./contracts";

const feedbackScenarios: ComparisonScenario[] = [false, true].map((detached) => ({
  id: `obsidian-loading-feedback-${detached ? "detached" : "overdue"}`,
  modules: ["obsidian/embeds/presentation-operation-feedback"],
  covers: [
    {
      file: "test/performance/obsidian/live-preview-entrances-performance.test.ts",
      test: detached
        ? "positions detached loading feedback after attachment within the frame budget"
        : "hands off overdue loading feedback synchronously within the frame budget",
      ordinals: [1],
    },
  ],
  statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
  execution: "sync",

  warmupOperations: 20,
  create(implementation) {
    const { PresentationOperationFeedback } = implementation.get<
      typeof import("../../../src/obsidian/embeds/presentation-operation-feedback")
    >("obsidian/embeds/presentation-operation-feedback");
    const root = new FakePresentationElement();
    const ownerWindow = root.ownerDocument.defaultView;
    assert.ok(ownerWindow);
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let timers = 0;
    Object.assign(ownerWindow, {
      performance: { now: () => 1000 },
      requestAnimationFrame(callback: FrameRequestCallback) {
        frames.set(++nextId, callback);
        return nextId;
      },
      cancelAnimationFrame: (handle: number) => frames.delete(handle),
      setTimeout: () => ++timers,
    });
    let feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
    let invalid = false;
    return {
      reset() {
        invalid = false;
        root.isConnected = !detached;
        if (detached) feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
      },
      run() {
        const operation = feedback.begin("loading", 0);
        const indicators = root.getElementsByClassName("inkbook-operation-feedback");
        const indicator = indicators.item(0);
        invalid = indicators.length !== 1;
        if (detached) {
          invalid ||=
            indicator?.classNames.has("inkbook-feedback-unmeasured") !== true || frames.size !== 1;
          root.isConnected = true;
          for (const [handle, callback] of frames) {
            frames.delete(handle);
            callback(0);
          }
        }
        invalid ||=
          indicator?.style.insetBlockStart !== "50px" ||
          indicator.style.insetInlineStart !== "300px";
        if (detached) feedback.dispose();
        else operation.finish();
      },
      verify() {
        assert.strictEqual(invalid, false);
        assert.strictEqual(root.children.length, 0);
        assert.strictEqual(frames.size, 0);
        assert.strictEqual(timers, 0);
      },
      dispose() {
        feedback.dispose();
      },
    };
  },
}));

const recognitionScenario: ComparisonScenario = {
  id: "obsidian-recognition-cache-eviction",
  modules: ["obsidian/embeds/document-recognition"],
  covers: [
    {
      file: "test/performance/obsidian/live-preview-entrances-performance.test.ts",
      test: "admits and completes recognition with bounded cache eviction within the frame budget",
      ordinals: [1],
    },
  ],
  statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
  execution: "async",

  warmupOperations: 20,
  async create(implementation) {
    const { ObsidianInkbookDocumentRecognition } = implementation.get<
      typeof import("../../../src/obsidian/embeds/document-recognition")
    >("obsidian/embeds/document-recognition");
    const { files, recognition } = recognitionCacheFixture(
      ObsidianInkbookDocumentRecognition,
      4096,
    );
    for (let index = 0; index < 300; index += 1) await recognition.recognize(files[index]!.path);
    let index = 300;
    return {
      run() {
        return recognition.recognize(files[index++ % files.length]!.path);
      },
      verify(result) {
        assert.strictEqual(result, false);
        assert.strictEqual(
          files.filter((file) => recognition.cached(file.path) !== undefined).length,
          256,
        );
      },
      dispose() {
        recognition.dispose();
      },
    };
  },
};

export const OBSIDIAN_EMBED_FEEDBACK_SCENARIOS: readonly ComparisonScenario[] = [
  ...feedbackScenarios,
  recognitionScenario,
];
