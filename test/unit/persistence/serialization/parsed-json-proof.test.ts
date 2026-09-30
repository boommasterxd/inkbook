import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import {
  validateInkSnapshotV1,
  validateParsedInkSnapshotV1Steps,
} from "../../../../src/domain/schema/snapshot-validation";
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
