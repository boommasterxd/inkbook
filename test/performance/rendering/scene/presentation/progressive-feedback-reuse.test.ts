import { afterEach, expect, it, vi } from "vitest";

import {
  ProgressiveFeedbackTransformCache,
  progressiveFeedbackTransform,
} from "../../../../../src/rendering/scene/presentation/progressive-feedback-transform";
import type {
  PreviewRequest,
  ProgressivePreviewTransform,
} from "../../../../../src/rendering/scene/presentation/progressive-preview-request";
import * as matrices from "../../../../../src/rendering/scene/presentation/selection-run-residuals";
import { createProgressivePreviewFixture } from "../../../../fixtures/rendering/progressive-element-preview";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

afterEach(() => vi.restoreAllMocks());

it("composes and serializes shared feedback once while writing all 10,005 legacy members", () => {
  const { preview, content } = createProgressivePreviewFixture();
  const elements = Array.from({ length: 10_005 }, (_, index) => indexedStroke(index));
  const sources = new Map(elements.map((element) => [element.id, element]));
  const ids = elements.map(({ id }) => id);
  const feedback = {
    transform: "scale(2 3)",
    inverse: "scale(.5 .3333333333333333)",
    matrix: [2, 0, 0, 3, 1e-7, 7] as const,
  };
  const expected = progressiveFeedbackTransform(feedback, undefined, 1, 1);
  const compose = vi.spyOn(matrices, "composeMatrices");
  const serialize = vi.spyOn(matrices, "matrixString");
  const request = {
    ids: ids.slice(0, 256),
    feedbackIds: ids,
    materialize: (id: string) => sources.get(id),
    isImmediate: () => false,
    feedback,
    version: 1,
  };
  preview.set(request);
  preview.writeFeedback(1, 0, () => 1);
  expect(compose).toHaveBeenCalledOnce();
  expect(serialize).toHaveBeenCalledOnce();
  expect(content.applyPreviewTransform.mock.calls.map(([id]) => id)).toEqual(ids);
  expect(new Set(content.applyPreviewTransform.mock.calls.map((call) => call[4])).size).toBe(1);
  expect(content.applyPreviewTransform).toHaveBeenLastCalledWith(
    ids[ids.length - 1],
    expected.transform,
    1,
    1,
    expected.matrix,
  );
  preview.writeFeedback(1, 0, () => 1);
  expect(content.applyPreviewTransform).toHaveBeenCalledTimes(ids.length);
  preview.applyMounted([ids[0]!, ids[ids.length - 1]!]);
  expect(content.applyPreviewTransform).toHaveBeenCalledTimes(ids.length + 2);
  expect(compose).toHaveBeenCalledOnce();
  expect(serialize).toHaveBeenCalledOnce();
  preview.writeFeedback(2, 0, () => 1);
  expect(content.applyPreviewTransform).toHaveBeenCalledTimes(ids.length * 2 + 2);
  expect(compose).toHaveBeenCalledTimes(2);
  expect(serialize).toHaveBeenCalledTimes(2);
  const calls = content.applyPreviewTransform.mock.calls;
  expect(calls[calls.length - 1]?.[3]).toBe(2);
  const retained = preview.memoryUsage();
  preview.set({ ...request });
  expect(preview.memoryUsage()).toBe(retained - 128 - 6 * 8 - expected.transform!.length * 2);
  preview.writeFeedback(2, 0, () => 1);
  expect(compose).toHaveBeenCalledTimes(3);
  expect(serialize).toHaveBeenCalledTimes(3);
  preview.clear();
  expect(preview.memoryUsage()).toBe(0);
});

it("retains one common result while calculating distinct snapshot bases independently", () => {
  const cache = new ProgressiveFeedbackTransformCache();
  const request = createRequest({
    transform: "scale(2 3)",
    inverse: "scale(.5 .3333333333333333)",
    matrix: [2, 0, 0, 3, 1e-7, 7],
  });
  const bases: readonly ProgressivePreviewTransform[] = [
    { transform: "translate(4 8)", inverse: "translate(-4 -8)", matrix: [1, 0, 0, 1, 4, 8] },
    { transform: "scale(.5 2)", inverse: "scale(2 .5)", matrix: [0.5, 0, 0, 2, 0, 0] },
  ];
  const expected = bases.map((basis) =>
    progressiveFeedbackTransform(request.feedback, basis, request.version, 1),
  );
  const common = cache.resolve(request, undefined, 1);
  const compose = vi.spyOn(matrices, "composeMatrices");
  const serialize = vi.spyOn(matrices, "matrixString");
  for (const [index, basis] of bases.entries()) {
    expect(cache.resolve(request, basis, 1)).toEqual(expected[index]);
  }
  expect(compose).toHaveBeenCalledTimes(2);
  expect(serialize).toHaveBeenCalledTimes(2);
  expect(cache.resolve(request, undefined, 1)).toBe(common);
  expect(compose).toHaveBeenCalledTimes(2);
  cache.clear();
  expect(cache.memoryUsage()).toBe(0);
});

it("preserves canonical finite, singular, nonfinite and opaque feedback bytes", () => {
  const cache = new ProgressiveFeedbackTransformCache();
  const cases: readonly {
    readonly feedback: ProgressivePreviewTransform | undefined;
    readonly basis?: ProgressivePreviewTransform;
  }[] = [
    {
      feedback: {
        transform: "translate(1e-7 7)",
        inverse: "translate(-1e-7 -7)",
        matrix: [1, 0, 0, 1, 1e-7, 7],
      },
    },
    { feedback: { transform: "scale(0 3)", inverse: "", matrix: [0, 0, 0, 3, 0, 0] } },
    { feedback: { transform: "opaque-current", inverse: "opaque-return" } },
    { feedback: { transform: "legacy-current", inverse: "", matrix: [Infinity, 0, 0, 1, 0, 0] } },
    {
      feedback: { transform: "scale(2)", inverse: "scale(.5)", matrix: [2, 0, 0, 2, 0, 0] },
      basis: { transform: "scale(0)", inverse: "legacy-inverse", matrix: [0, 0, 0, 0, 0, 0] },
    },
    { feedback: undefined },
  ];
  for (const [index, { feedback, basis }] of cases.entries()) {
    const request = createRequest(feedback, index + 1);
    const reference = progressiveFeedbackTransform(feedback, basis, request.version, 2);
    expect(JSON.stringify(cache.resolve(request, basis, 2))).toBe(JSON.stringify(reference));
  }
  cache.clear();
  expect(cache.memoryUsage()).toBe(0);
});

it("replaces its single memory reservation on new requests and releases it on clear", () => {
  const cache = new ProgressiveFeedbackTransformCache();
  expect(cache.memoryUsage()).toBe(0);
  for (let version = 1; version <= 32; version += 1) {
    const feedback = {
      transform: `translate(${version} 7)`,
      inverse: `translate(${-version} -7)`,
      matrix: [1, 0, 0, 1, version, 7] as const,
    };
    const request = createRequest(feedback, version);
    const result = cache.resolve(request, undefined, 1);
    expect(cache.memoryUsage()).toBe(128 + 6 * 8 + result.transform!.length * 2);
    expect(cache.resolve(request, undefined, 1)).toBe(result);
  }
  cache.clear();
  expect(cache.memoryUsage()).toBe(0);
});

function createRequest(
  feedback: ProgressivePreviewTransform | undefined,
  version = 1,
): PreviewRequest {
  return { ids: [], materialize: () => undefined, feedback, version };
}
