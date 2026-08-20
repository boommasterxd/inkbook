/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact processor boundaries define this integration test. */
import { describe, expect, it } from "vitest";

import {
  DELTA_VARINT_DECODE_MAX_UNITS_V1,
  createSerializedSceneValidationProcessorV1,
  encodeDeltaVarintStroke,
} from "../../../src/domain/codecs";
import type {
  DeltaVarintSampleV1,
  EncodedStrokeV1,
} from "../../../src/domain/codecs";
import type { SceneElementV1 } from "../../../src/domain/model";
import { completeScene } from "./scene-support";

const MAX_STROKE_POINTS = 200_000;

type MutableEncodedStrokeV1 = {
  -readonly [Key in keyof EncodedStrokeV1]: EncodedStrokeV1[Key];
};

function driveScene(pointCount: number): number {
  const { processor, element } = sceneProcessor(pointCount);
  let calls = 0;
  while (!processor.processNext()) calls += 1;
  expect(processor.complete()?.elements[0]).toEqual(element);
  return calls + 1;
}

function sceneProcessor(pointCount: number): {
  readonly element: SceneElementV1;
  readonly processor: ReturnType<
    typeof createSerializedSceneValidationProcessorV1
  >;
  readonly stroke: MutableEncodedStrokeV1;
} {
  const source = completeScene();
  const pen = source.elements[0];
  if (pen?.kind !== "pen") throw new Error("Expected Pen fixture.");
  const samples = Array.from(
    { length: pointCount },
    (_, index): DeltaVarintSampleV1 => ({
      x: index * 0.01,
      y: 0,
      elapsedMs: index,
    }),
  );
  const stroke = { ...encodeDeltaVarintStroke(samples, "absent") };
  const element = {
    ...pen,
    geometry: { ...pen.geometry, stroke },
  };
  return {
    element,
    processor: createSerializedSceneValidationProcessorV1(
      {
        ...source,
        elements: [element],
        objectOrder: [element.elementId],
        groups: [],
      },
      1,
    ),
    stroke,
  };
}

describe("resumable scene stroke decoding", () => {
  it("validates a maximum-size stroke over multiple bounded turns", () => {
    const smallCalls = driveScene(1);
    const largeCalls = driveScene(MAX_STROKE_POINTS);

    expect(largeCalls).toBeGreaterThan(
      smallCalls + MAX_STROKE_POINTS / DELTA_VARINT_DECODE_MAX_UNITS_V1,
    );
  });

  it("publishes the validated snapshot when source bytes mutate between slices", () => {
    const { processor, stroke } = sceneProcessor(
      DELTA_VARINT_DECODE_MAX_UNITS_V1 + 2,
    );
    const validatedData = stroke.data;

    expect(processor.processNext()).toBe(false);
    expect(processor.processNext()).toBe(false);
    expect(processor.processNext()).toBe(false);
    stroke.data = "AA";
    while (!processor.processNext()) {
      // Continue from the immutable stroke snapshot captured in the first pass.
    }

    const result = processor.complete()?.elements[0];
    if (result?.kind !== "pen") throw new Error("Expected validated Pen.");
    expect(result.geometry.stroke.data).toBe(validatedData);
    expect(result.geometry.stroke).not.toBe(stroke);
  });
});
