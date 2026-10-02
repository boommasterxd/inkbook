import { describe, expect, it } from "vitest";
import { validatePreparedScenePaths } from "../../../../../src/persistence/worker/runtime/prepare-scene-paths";
import { MAX_SCENE_PATH_BYTES } from "../../../../../src/persistence/worker/runtime/scene-path-limits";
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
