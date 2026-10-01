import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import {
  validateInkSnapshotV1,
  validateParsedInkSnapshotV1Steps,
  validateRuntimeInkSnapshotV1,
} from "../../../../src/domain/schema/snapshot-validation";
import { decodeCompactSnapshotSteps } from "../../../../src/persistence/serialization/compact-snapshot";
import { encodeStrokeSamples } from "../../../../src/persistence/serialization/stroke-sample-codec";
import type { InkSnapshotV1, StrokeElementV1 } from "../../../../src/domain/schema/types";
import {
  jsonContainerBudget,
  jsonNodeBudget,
} from "../../../../src/domain/schema/validation-internals";
import { parseChunkedJsonWithProof } from "../../../../src/persistence/serialization/chunked-json-parser";
import { createOneStrokeWorkerSnapshot } from "../../../fixtures/persistence/worker-bridge";
import { finishGeometrySteps as complete } from "../../../fixtures/domain/geometry-steps";

afterEach(() => vi.restoreAllMocks());

async function parsed(text = JSON.stringify(createOneStrokeWorkerSnapshot())) {
  return parseChunkedJsonWithProof(text, {
    limits: {
      maximumContainerEntries: jsonContainerBudget(FILE_SCHEMA_LIMITS),
      maximumDepth: 32,
      maximumNodes: jsonNodeBudget(FILE_SCHEMA_LIMITS),
      maximumOutputCharacters: text.length,
      maximumStringScratchCharacters: 65536,
    },
  });
}

describe("parser-owned structural validation", () => {
  it("skips descriptor walks once while preserving schema validation and root identity", async () => {
    const owned = await parsed();
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    expect(complete(validateParsedInkSnapshotV1Steps(owned.value, owned.proof)).ok).toBe(true);
    expect(descriptors).not.toHaveBeenCalled();
    expect(complete(validateParsedInkSnapshotV1Steps(owned.value, owned.proof)).ok).toBe(true);
    expect(descriptors).toHaveBeenCalled();
    const other = await parsed();
    descriptors.mockClear();
    expect(complete(validateParsedInkSnapshotV1Steps(owned.value, other.proof)).ok).toBe(true);
    expect(descriptors).toHaveBeenCalled();
  });

  it("keeps semantic range checks and non-finite JSON rejection", async () => {
    const source = JSON.stringify(createOneStrokeWorkerSnapshot());
    const invalid = await parsed(source.replace('"width":2', '"width":0'));
    expect(complete(validateParsedInkSnapshotV1Steps(invalid.value, invalid.proof)).ok).toBe(false);
    const infinite = await parsed(source.replace('"width":2', '"width":1e999'));
    expect(complete(validateParsedInkSnapshotV1Steps(infinite.value, infinite.proof)).ok).toBe(
      false,
    );
  });

  it("fully inspects general objects with accessors or inherited properties", () => {
    const source = createOneStrokeWorkerSnapshot();
    Object.defineProperty(source, "revision", { get: () => 0, enumerable: true });
    expect(validateInkSnapshotV1(source).ok).toBe(false);
    expect(
      validateInkSnapshotV1(
        Object.assign(Object.create({ inherited: true }), createOneStrokeWorkerSnapshot()),
      ).ok,
    ).toBe(false);
  });

  it("rechecks structural limits when parser limits exceed a consumer's capacity", async () => {
    const wide = await parsed(JSON.stringify(Array.from({ length: 1000 }, () => 0)));
    const result = complete(
      validateParsedInkSnapshotV1Steps(wide.value, wide.proof, {
        limits: { ...FILE_SCHEMA_LIMITS, elements: 1, pointsPerStroke: 1, strokePoints: 1 },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "json-node-limit-exceeded" } });
  });
});

async function decoded(points = [-3, -4, 0.1235, 3, 4, 1], offset?: { x: number; y: number }) {
  const source = createOneStrokeWorkerSnapshot();
  const stroke = source.elements[0] as StrokeElementV1;
  stroke.pivot = { x: 0, y: 0 };
  if (offset !== undefined) stroke.offset = offset;
  const disk = { ...source, elements: [{ ...stroke, points: encodeStrokeSamples(points) }] };
  const owned = await parsed(JSON.stringify(disk));
  complete(decodeCompactSnapshotSteps(owned.value, undefined, { proof: owned.proof }));
  return { ...owned, snapshot: owned.value as InkSnapshotV1 };
}

describe("parser-owned decoded stroke validation", () => {
  it("retains raw decoded values and extrema while counting every document point", async () => {
    const owned = await decoded();
    const result = complete(validateParsedInkSnapshotV1Steps(owned.value, owned.proof, {}, true));

    expect(result).toMatchObject({ ok: true, statistics: { strokes: 1, strokePoints: 2 } });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.derivations.elements[0]?.strokeSampleExtrema).toEqual({
      minX: -3,
      minY: -4,
      maxX: 3,
      maxY: 4,
    });
    expect((result.value.elements[0] as StrokeElementV1).points).toEqual(
      new Float64Array([-3, -4, 0.1235, 3, 4, 1]),
    );
  });

  it("accepts exact translated coordinate boundaries from decoded extrema", async () => {
    const owned = await decoded(undefined, { x: 1, y: 0 });
    expect(
      complete(
        validateParsedInkSnapshotV1Steps(
          owned.value,
          owned.proof,
          {
            limits: { ...FILE_SCHEMA_LIMITS, absoluteCoordinate: 4 },
          },
          true,
        ),
      ),
    ).toMatchObject({ ok: true, statistics: { strokePoints: 2 } });
  });

  it.each([
    [{ pointsPerStroke: 1 }, undefined, "invalid-stroke-samples"],
    [{ strokePoints: 1 }, undefined, "stroke-point-limit-exceeded"],
    [{ absoluteCoordinate: 3 }, undefined, "invalid-range"],
    [{ absoluteCoordinate: 4 }, { x: 2, y: 0 }, "invalid-range"],
    [{ absoluteCoordinate: 4 }, { x: -2, y: 0 }, "invalid-range"],
    [{ absoluteCoordinate: 4 }, { x: 0, y: 1 }, "invalid-range"],
    [{ absoluteCoordinate: 4 }, { x: 0, y: -1 }, "invalid-range"],
  ])("preserves decoder-independent limits %j and offset %j", async (limits, offset, code) => {
    const owned = await decoded(undefined, offset);
    expect(
      complete(
        validateParsedInkSnapshotV1Steps(
          owned.value,
          owned.proof,
          {
            limits: { ...FILE_SCHEMA_LIMITS, ...limits },
          },
          true,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code } });
  });
});

describe("decoded stroke ownership boundaries", () => {
  it("rejects changed mutable buffers after publication and on repeated proof use", async () => {
    const owned = await decoded();
    expect(complete(validateParsedInkSnapshotV1Steps(owned.value, owned.proof, {}, true)).ok).toBe(
      true,
    );
    const stroke = owned.snapshot.elements[0] as StrokeElementV1;
    stroke.points[2] = Number.NaN;

    expect(validateRuntimeInkSnapshotV1(owned.value)).toMatchObject({
      ok: false,
      error: { code: "invalid-range" },
    });
    expect(
      complete(validateParsedInkSnapshotV1Steps(owned.value, owned.proof, {}, true)),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-range" },
    });
  });

  it("does not trust decoded buffers without their matching parser root proof", async () => {
    const owned = await decoded();
    const other = await parsed();
    const stroke = owned.snapshot.elements[0] as StrokeElementV1;
    stroke.points[0] = 0.0001;
    expect(
      complete(validateParsedInkSnapshotV1Steps(owned.value, other.proof, {}, true)),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-number" },
    });
    expect(validateRuntimeInkSnapshotV1(owned.value)).toMatchObject({
      ok: false,
      error: { code: "invalid-number" },
    });
  });

  it("rescans replacement arrays even when the parser root proof matches", async () => {
    const owned = await decoded();
    const stroke = owned.snapshot.elements[0] as StrokeElementV1;
    expect(owned.proof.consumeDecodedStrokeSamples(stroke.points)).toBeUndefined();
    stroke.points = [0, 0, 2];

    expect(
      complete(validateParsedInkSnapshotV1Steps(owned.value, owned.proof, {}, true)),
    ).toMatchObject({ ok: false, error: { code: "invalid-range" } });
  });
});
