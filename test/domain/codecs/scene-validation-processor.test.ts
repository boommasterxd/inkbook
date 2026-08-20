/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact work-unit counts and resource boundaries define these processor tests. */
import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  createSerializedSceneValidationProcessorV1,
  SCENE_RESOURCE_LIMITS_V1,
} from "../../../src/domain/codecs";
import type { SceneElementV1 } from "../../../src/domain/model";
import { completeScene } from "./scene-support";

const MIN_STROKE_WORK_CALLS = 5;

function drive(
  processor: ReturnType<typeof createSerializedSceneValidationProcessorV1>,
): number {
  let units = 0;
  while (!processor.processNext()) units += 1;
  return units + 1;
}

function driveUntilFailure(
  processor: ReturnType<typeof createSerializedSceneValidationProcessorV1>,
): { readonly calls: number; readonly error: Error } {
  let calls = 0;
  for (;;) {
    calls += 1;
    try {
      processor.processNext();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { calls, error };
    }
  }
}

function paddedScene(byteLength: number): unknown {
  const source = completeScene();
  const first = source.elements[0];
  if (first === undefined) throw new Error("Expected an element fixture.");
  const element = { ...first, padding: "" };
  const scene = {
    ...source,
    elements: [element],
    objectOrder: [element.elementId],
    groups: [],
  };
  const emptyLength = new TextEncoder().encode(canonicalizeJson(scene)).length;
  element.padding = "x".repeat(byteLength - emptyLength);
  return scene;
}

describe("resumable scene validation", () => {
  it("publishes only after bounded record passes and complete performs no work", () => {
    const source = completeScene();
    const processor = createSerializedSceneValidationProcessorV1(source, 1);

    expect(processor.complete()).toBeUndefined();
    const units = drive(processor);
    const result = processor.complete();

    expect(units).toBeGreaterThan(
      source.elements.length + source.objectOrder.length + source.groups.length,
    );
    expect(result?.elements).toHaveLength(source.elements.length);
    expect(processor.complete()).toBe(result);
  });

  it("does not inspect a scene element during O(1) envelope admission", () => {
    const source = completeScene();
    const elements = [...source.elements];
    Object.defineProperty(elements, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("element accessed");
      },
    });

    let processor:
      ReturnType<typeof createSerializedSceneValidationProcessorV1> | undefined;
    expect(() => {
      processor = createSerializedSceneValidationProcessorV1({
        ...source,
        elements,
      });
    }).not.toThrow();
    expect(() => processor?.processNext()).toThrow(/data properties/u);
  });
});

describe("resumable scene resource admission", () => {
  it("admits aggregate stroke points before any element materialization", () => {
    const source = completeScene();
    const pen = source.elements[0];
    if (pen?.kind !== "pen") throw new Error("Expected Pen fixture.");
    const overflow = {
      ...pen,
      geometry: {
        ...pen.geometry,
        stroke: { ...pen.geometry.stroke, pointCount: 500_001 },
      },
    } as SceneElementV1;
    const processor = createSerializedSceneValidationProcessorV1({
      ...source,
      elements: [overflow],
      objectOrder: [overflow.elementId],
      groups: [],
    });

    expect(driveUntilFailure(processor).error.message).toMatch(
      /Aggregate stroke points/u,
    );
    expect(processor.complete()).toBeUndefined();
  });

  it.each([
    ["below", SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes - 1, /closed V1/u],
    ["at", SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes, /closed V1/u],
    ["above", SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes + 1, /UTF-8 limit/u],
  ] as const)(
    "counts canonical UTF-8 %s the scene limit",
    (_boundary, byteLength, expectedError) => {
      const processor = createSerializedSceneValidationProcessorV1(
        paddedScene(byteLength),
      );
      expect(() => drive(processor)).toThrow(expectedError);
    },
  );

  it("reserves separate work units for large encoded stroke chunks", () => {
    const source = completeScene();
    const pen = source.elements[0];
    if (pen?.kind !== "pen") throw new Error("Expected Pen fixture.");
    const invalidLargeStroke = {
      ...pen,
      geometry: {
        ...pen.geometry,
        stroke: {
          ...pen.geometry.stroke,
          pointCount: 1,
          data: "A".repeat(32_769),
        },
      },
    };
    const processor = createSerializedSceneValidationProcessorV1({
      ...source,
      elements: [invalidLargeStroke],
      objectOrder: [invalidLargeStroke.elementId],
      groups: [],
    });

    const failure = driveUntilFailure(processor);
    expect(failure.calls).toBeGreaterThan(MIN_STROKE_WORK_CALLS);
    expect(failure.error.message).toMatch(/encoded byte limit/u);
  });

  it("releases retained state and rejects further access after disposal", () => {
    const processor =
      createSerializedSceneValidationProcessorV1(completeScene());
    processor.dispose();

    expect(() => processor.processNext()).toThrow(/disposed/u);
    expect(() => processor.complete()).toThrow(/disposed/u);
  });
});
