/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact capacity sizes, seeds, and byte budgets are intentional. */
import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeJson,
  decodeSceneJsonV1,
  decodeSceneStateV1,
  encodeDeltaVarintStroke,
  encodeRuntimeSceneJsonV1,
  SCENE_RESOURCE_LIMITS_V1,
  serializeRuntimeSceneStateV1,
  validateSerializedSceneStateV1,
} from "../../../src/domain/codecs";
import type { SceneElementV1 } from "../../../src/domain/model";
import { createSceneRevision, parseHexRgbaV1 } from "../../../src/domain/model";
import type { SerializedSceneStateV1 } from "../../../src/domain/scene";
import * as canonicalJsonCodec from "../../../src/domain/codecs/canonical-json";
import { rectangleElement } from "../model/support";
import { completeScene } from "./scene-support";

const CURRENT_VERSION = Object.freeze({ major: 1, minor: 0 });
const PHONE_WRITE_LIMIT = 8 * 1_024 * 1_024;
const HEADROOM_FACTOR = 1.1;
const MINIMUM_CAPACITY = 5_000;
const STRESS_CAPACITY = 10_000;
const COVERAGE_STRESS_TIMEOUT_MS = 15_000;
const POINTS_PER_STROKE = 25;
const STRESS_POINT_COUNT = STRESS_CAPACITY * POINTS_PER_STROKE;
const FUZZ_CASES = 128;
const FUZZ_SEED = 0x4f_91_2a_77;
const UINT32_SPAN = 0x1_0000_0000;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const GENERATED_STROKE = encodeDeltaVarintStroke(
  Array.from({ length: POINTS_PER_STROKE }, (_, index) => ({
    x: index / 100,
    y: index / 100,
    elapsedMs: index,
  })),
  "absent",
);

function generatedStrokeElement(index: number): SceneElementV1 {
  const common = rectangleElement(index);
  return {
    elementId: common.elementId,
    geometryRevision: common.geometryRevision,
    styleRevision: common.styleRevision,
    bindingRevision: common.bindingRevision,
    binding: common.binding,
    kind: "pen",
    geometry: { stroke: GENERATED_STROKE, selectionRotationRadians: 0 },
    style: {
      color: parseHexRgbaV1("#123456ff"),
      opacity: 0.58,
      width: 1,
      dash: "solid",
      pressure: "constant",
      smoothing: 0.29,
      streamline: 0.58,
      thinning: 0,
      strokeProfileVersion: 1,
    },
  };
}

function generatedScene(size: number): SerializedSceneStateV1 {
  const elements = Array.from({ length: size }, (_, index) =>
    generatedStrokeElement(index),
  );
  return {
    revision: createSceneRevision(size),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups: [],
    noteAppearance: {
      background: "none",
      horizontalSpacing: "standard",
      contrast: "low",
    },
  };
}

function expectCapacityRoundTrip(size: number): void {
  const source = generatedScene(size);
  const runtime = validateSerializedSceneStateV1(source);
  const encoded = encodeRuntimeSceneJsonV1(runtime);
  const decoded = decodeSceneJsonV1(encoded, CURRENT_VERSION);

  expect(decoded.kind).toBe("current");
  if (decoded.kind !== "current") return;
  expect(decoded.scene.elementsById.size).toBe(size);
  expect(decoded.scene.objectOrder).toHaveLength(size);
  if (size !== STRESS_CAPACITY) return;
  const points = source.elements.reduce(
    (total, element) =>
      total +
      (element.kind === "pen" || element.kind === "highlighter"
        ? element.geometry.stroke.pointCount
        : 0),
    0,
  );
  expect(points).toBe(STRESS_POINT_COUNT);
  expect(encoded.byteLength * HEADROOM_FACTOR).toBeLessThanOrEqual(
    PHONE_WRITE_LIMIT,
  );
}

describe("scene canonical codec", () => {
  it("round-trips the complete closed V1 scene in canonical JSON", () => {
    const source = completeScene();
    const runtime = validateSerializedSceneStateV1(source);
    const encoded = encodeRuntimeSceneJsonV1(runtime);
    const text = new TextDecoder().decode(encoded);
    const decoded = decodeSceneJsonV1(encoded, CURRENT_VERSION);

    expect(text).toBe(canonicalizeJson(source));
    expect(text.endsWith("\n")).toBe(false);
    expect(decoded.kind).toBe("current");
    if (decoded.kind !== "current") return;
    expect(serializeRuntimeSceneStateV1(decoded.scene)).toEqual(source);
  });

  it("detects duplicate JSON keys, unknown fields, invalid Unicode, and BOM", () => {
    expect(() =>
      decodeSceneJsonV1('{"revision":0,"revision":0}', CURRENT_VERSION),
    ).toThrow(/duplicate-key/u);
    expect(() =>
      decodeSceneStateV1(
        { ...completeScene(), hostLayoutRevision: 1 },
        CURRENT_VERSION,
      ),
    ).toThrow(/closed V1/u);
    expect(() =>
      decodeSceneJsonV1(`{"bad":"${String.fromCharCode(0xd800)}"}`, {
        major: 2,
        minor: 0,
      }),
    ).toThrow(/invalid-unicode/u);
    expect(() =>
      decodeSceneJsonV1(
        `\ufeff${canonicalizeJson(completeScene())}`,
        CURRENT_VERSION,
      ),
    ).toThrow(/BOM/u);
    expect(() =>
      decodeSceneJsonV1(
        " ".repeat(SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes + 1),
        CURRENT_VERSION,
      ),
    ).toThrow(/utf8-byte-limit/u);
    expect(
      decodeSceneJsonV1(
        `${" ".repeat(SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes - 2)}{}`,
        { major: 2, minor: 0 },
      ).kind,
    ).toBe("read-only-newer-version");
  });

  it("returns bounded future versions read-only without runtime construction", () => {
    const futureMinor = decodeSceneStateV1(
      { future: { retained: true } },
      { major: 1, minor: 1 },
    );
    const futureMajor = decodeSceneJsonV1('{"future":[1,2,3]}', {
      major: 2,
      minor: 0,
    });

    expect(futureMinor).toEqual({
      kind: "read-only-newer-version",
      schemaVersion: { major: 1, minor: 1 },
    });
    expect(futureMajor.kind).toBe("read-only-newer-version");
    expect(() => decodeSceneStateV1({}, { major: 0, minor: 9 })).toThrow(
      /unsupported/u,
    );
  });
});

describe("scene codec boundaries", () => {
  it("reuses measured bytes and incrementally admits direct current scenes", () => {
    const encodeSpy = vi.spyOn(canonicalJsonCodec, "encodeCanonicalJson");
    try {
      const source = completeScene();
      const sourceJson = canonicalizeJson(source);

      expect(decodeSceneJsonV1(sourceJson, CURRENT_VERSION).kind).toBe(
        "current",
      );
      expect(
        decodeSceneJsonV1('{"future":true}', { major: 2, minor: 0 }).kind,
      ).toBe("read-only-newer-version");
      expect(encodeSpy).not.toHaveBeenCalled();

      expect(decodeSceneStateV1(source, CURRENT_VERSION).kind).toBe("current");
      expect(
        decodeSceneStateV1({ future: true }, { major: 2, minor: 0 }).kind,
      ).toBe("read-only-newer-version");
      expect(encodeSpy).toHaveBeenCalledTimes(1);
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("rejects over-limit imported contexts when attempting a V1 write", () => {
    const source = structuredClone(completeScene());
    const elements = [...source.elements];
    const position = elements[0];
    if (position?.binding.kind !== "text-position") {
      throw new TypeError("Expected Text-position fixture.");
    }
    elements[0] = {
      ...position,
      binding: {
        ...position.binding,
        anchor: { ...position.binding.anchor, contextBefore: "x".repeat(129) },
      },
    };
    const runtime = validateSerializedSceneStateV1({ ...source, elements });

    expect(() => encodeRuntimeSceneJsonV1(runtime)).toThrow(/128/u);
    const atLimitElements = [...source.elements];
    atLimitElements[0] = {
      ...position,
      binding: {
        ...position.binding,
        anchor: { ...position.binding.anchor, contextBefore: "x".repeat(128) },
      },
    };
    const atLimitRuntime = validateSerializedSceneStateV1({
      ...source,
      elements: atLimitElements,
    });
    expect(() => encodeRuntimeSceneJsonV1(atLimitRuntime)).not.toThrow();
  });
});

describe("scene malicious and generated workloads", () => {
  it("rejects deterministic seeded unknown-field mutations", () => {
    let state = FUZZ_SEED;
    for (let iteration = 0; iteration < FUZZ_CASES; iteration += 1) {
      state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % UINT32_SPAN;
      const scene = structuredClone(completeScene());
      const elements = [...scene.elements];
      const index = state % elements.length;
      const element = elements[index];
      if (element === undefined) throw new TypeError("Missing fuzz fixture.");
      elements[index] = {
        ...element,
        [`unknown${String(state)}`]: true,
      };
      expect(() =>
        validateSerializedSceneStateV1({ ...scene, elements }),
      ).toThrow(/closed V1/u);
    }
  });

  it(
    "round-trips a generated 5,000-element scene within parser limits",
    () => {
      expectCapacityRoundTrip(MINIMUM_CAPACITY);
    },
    COVERAGE_STRESS_TIMEOUT_MS,
  );

  it(
    "round-trips a generated 10,000-element scene within parser limits",
    () => {
      expectCapacityRoundTrip(STRESS_CAPACITY);
    },
    COVERAGE_STRESS_TIMEOUT_MS,
  );
});
