import { describe, expect, it } from "vitest";
import { validatePreparedScenePaths } from "../../../../../src/persistence/worker/runtime/prepare-scene-paths";
import {
  MAX_SCENE_PATH_BYTES,
  ScenePathValidationContext,
} from "../../../../../src/persistence/worker/runtime/scene-path-limits";
import { ScenePathOperation } from "../../../../../src/persistence/worker/runtime/scene-path-operation";
import { decodeRuntimeRequest } from "../../../../../src/persistence/worker/runtime/wire-codec";
import type { PreparedScenePathsRuntimeSuccess } from "../../../../../src/persistence/worker/runtime/types";

const identity = {
  operationId: 1,
  purpose: "background" as const,
  sessionId: "session-a",
  workerEpoch: 1,
};
const request = {
  basisRevision: 0,
  identity,
  ids: ["plain", "pressure"],
  type: "prepare-scene-paths" as const,
};

describe("exact visible prefix request validation", () => {
  it.each([undefined, 0, 1, 2])(
    "preserves an optional bounded prefix %s across admission and wire decoding",
    (visibleCount) => {
      const candidate = { ...request, ...(visibleCount === undefined ? {} : { visibleCount }) };
      expect(new ScenePathValidationContext(candidate).request.visibleCount).toBe(visibleCount);
      expect(new ScenePathOperation(candidate).request.visibleCount).toBe(visibleCount);
      expect(decodeRuntimeRequest(candidate)).toEqual(candidate);
    },
  );

  it.each([undefined, 1, MAX_SCENE_PATH_BYTES])(
    "preserves available byte capacity %s",
    (maxBytes) => {
      const candidate = { ...request, ...(maxBytes === undefined ? {} : { maxBytes }) };
      expect(new ScenePathValidationContext(candidate).request.maxBytes).toBe(maxBytes);
      expect(new ScenePathOperation(candidate).request.maxBytes).toBe(maxBytes);
      expect(decodeRuntimeRequest(candidate)).toEqual(candidate);
    },
  );

  it.each([undefined, false, true])("preserves speculative admission %s", (speculative) => {
    const candidate = { ...request, ...(speculative === undefined ? {} : { speculative }) };
    expect(new ScenePathOperation(candidate).request.speculative).toBe(speculative);
    expect(new ScenePathValidationContext(candidate).request.speculative).toBe(speculative);
    expect(decodeRuntimeRequest(candidate)).toEqual(candidate);
  });

  it.each([
    ...[-1, 3, 0.5, NaN, Infinity, null, "1"].map((visibleCount) => ({
      visibleCount: visibleCount as number,
    })),
    ...[0, -1, MAX_SCENE_PATH_BYTES + 1, 0.5, NaN, Infinity, null, "1"].map((maxBytes) => ({
      maxBytes: maxBytes as number,
    })),
    ...[null, 0, "true"].map((speculative) => ({ speculative: speculative as unknown as boolean })),
  ])("rejects malformed priority or capacity before admission: %j", (options) => {
    const candidate = { ...request, ...options };
    expect(() => new ScenePathValidationContext(candidate)).toThrow(TypeError);
    expect(() => new ScenePathOperation(candidate)).toThrow(TypeError);
    expect(() => decodeRuntimeRequest(candidate)).toThrow(TypeError);
  });
});

function result(paths: unknown): PreparedScenePathsRuntimeSuccess {
  return {
    basisRevision: 0,
    identity,
    paths,
    type: "prepare-scene-paths-success",
  } as PreparedScenePathsRuntimeSuccess;
}

describe("prepared scene path transport validation", () => {
  it("accepts canonical plain and pressure paints and checks the shared scheduler", async () => {
    let checkpoints = 0;
    await validatePreparedScenePaths(
      request,
      result([
        { id: "plain", parts: [{ d: "M0 0L1 1", paint: "stroke" }] },
        { id: "pressure", parts: [{ d: "M0 0L1 1Z", paint: "fill" }] },
      ]),
      {
        checkpoint: () => {
          checkpoints++;
          return Promise.resolve();
        },
        signal: new AbortController().signal,
      },
    );
    expect(checkpoints).toBe(2);
  });

  it("rejects cancellation during a suspended shared checkpoint", async () => {
    const controller = new AbortController();
    await expect(
      validatePreparedScenePaths(
        request,
        result([{ id: "plain", parts: [{ d: "M0 0L1 1", paint: "stroke" }] }]),
        {
          checkpoint: () => {
            controller.abort(new Error("cancelled"));
            return Promise.resolve();
          },
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("cancelled");
  });

  it.each([
    { label: "empty", parts: [] },
    { label: "null", parts: [null] },
    { label: "undefined", parts: [undefined] },
    { label: "non-string", parts: [{ d: 1, paint: "stroke" }] },
    { label: "unsupported paint", parts: [{ d: "M0 0", paint: "fill-and-stroke" }] },
    { label: "markup", parts: [{ d: "M0 0<script>", paint: "stroke" }] },
    {
      label: "multiple",
      parts: [
        { d: "M0 0", paint: "stroke" },
        { d: "M1 1", paint: "stroke" },
      ],
    },
    { label: "oversized", parts: [{ d: "0".repeat(MAX_SCENE_PATH_BYTES / 2), paint: "stroke" }] },
  ])("rejects $label canonical stroke parts", async ({ parts }) => {
    await expect(
      validatePreparedScenePaths(request, result([{ id: "plain", parts }]), {
        checkpoint: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(TypeError);
  });

  it.each(
    [
      [{ id: "foreign", parts: [{ d: "M0 0", paint: "stroke" }] }],
      [
        { id: "plain", parts: [{ d: "M0 0", paint: "stroke" }] },
        { id: "plain", parts: [{ d: "M0 0", paint: "stroke" }] },
      ],
      [
        { id: "pressure", parts: [{ d: "M0 0", paint: "fill" }] },
        { id: "plain", parts: [{ d: "M0 0", paint: "stroke" }] },
      ],
    ].map((paths) => [paths]),
  )("rejects foreign, duplicate, or reordered IDs: %j", async (paths) => {
    await expect(
      validatePreparedScenePaths(request, result(paths), {
        checkpoint: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(TypeError);
  });
});
