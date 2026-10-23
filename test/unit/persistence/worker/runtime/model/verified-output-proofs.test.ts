import { afterEach, describe, expect, it, vi } from "vitest";
import * as union from "../../../../../../src/domain/geometry/pressure/pressure-union";
import { serializeInkbookDocument } from "../../../../../../src/persistence/serialization/document-codec";
import { DocumentModelRuntime } from "../../../../../../src/persistence/worker/runtime/model/document-model";
import { createAllElementSnapshot } from "../../../serialization/fixtures";

function source(revision = 1) {
  const snapshot = { ...createAllElementSnapshot(), revision };
  const result = serializeInkbookDocument(snapshot);
  if (!result.ok) throw new Error(result.error.code);
  return { snapshot, svg: result.value.svg, hash: result.value.hash };
}

async function exportRevision(model: DocumentModelRuntime, revision: number) {
  return model.export({
    type: "export-full",
    baseModelRevision: null,
    snapshot: source(revision).snapshot,
    modelRevision: revision,
    sessionId: "proof",
    workerEpoch: 1,
    exportGeneration: revision,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("confirmed scalar output byte proofs", () => {
  it("binds confirmed scalar evidence to exact input bytes, host size, revision, and lifetime", async () => {
    const input = source();
    const model = new DocumentModelRuntime();
    const expectedBytes = new TextEncoder().encode(input.svg).byteLength;
    const build = vi.spyOn(union, "iteratePressureUnion");
    const confirmedBase = { outputHash: input.hash, revision: 1 };
    expect(
      await model.verifyOutput(input.svg, undefined, { confirmedBase, expectedBytes }),
    ).toEqual(confirmedBase);
    expect(build).not.toHaveBeenCalled();
    expect(
      await model.verifyOutput(input.svg, undefined, {
        confirmedBase,
        expectedBytes: expectedBytes - 1,
      }),
    ).toBeNull();
    expect(
      await model.verifyOutput(input.svg, undefined, { confirmedBase, expectedBytes: Number.NaN }),
    ).toBeNull();
    expect(build).not.toHaveBeenCalled();
    expect(
      await model.verifyOutput(input.svg + "\n", undefined, {
        confirmedBase,
        expectedBytes: expectedBytes + 1,
      }),
    ).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
    model.clear();
    expect(
      await model.verifyOutput(input.svg, undefined, {
        confirmedBase: { ...confirmedBase, revision: 2 },
        expectedBytes,
      }),
    ).toEqual(confirmedBase);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("runtime-owned output byte proofs", () => {
  it("fully verifies safe unlocked bytes once and checks changed or invalid input", async () => {
    const input = source();
    const model = new DocumentModelRuntime();
    await model.unlock(input.svg);
    const build = vi.spyOn(union, "iteratePressureUnion");
    expect(await model.verifyOutput(new TextEncoder().encode(input.svg))).toEqual({
      outputHash: input.hash,
      revision: 1,
    });
    expect(build).toHaveBeenCalledTimes(1);
    expect(await model.verifyOutput(input.svg + "\n")).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(2);
    expect(await model.verifyOutput(input.svg + "\n")).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(2);
    expect(await model.verifyOutput(input.svg.replace("</svg>", "<script/></svg>"))).toBeNull();
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("retains the validated input across exports but replaces the one export slot", async () => {
    const input = source();
    const model = new DocumentModelRuntime();
    await model.unlock(input.svg);
    await model.verifyOutput(input.svg);
    const second = await exportRevision(model, 2);
    const third = await exportRevision(model, 3);
    if (!second.ok || !third.ok) throw new Error("Export failed");
    const build = vi.spyOn(union, "iteratePressureUnion");
    expect((await model.verifyOutput(input.svg))?.revision).toBe(1);
    expect((await model.verifyOutput(third.output))?.revision).toBe(3);
    expect(build).not.toHaveBeenCalled();
    expect((await model.verifyOutput(second.output))?.revision).toBe(2);
    expect(build).toHaveBeenCalledTimes(1);
    model.clear();
    expect((await model.verifyOutput(third.output))?.revision).toBe(3);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("does not publish cancelled unlock/export or reuse after initialization", async () => {
    const input = source();
    const model = new DocumentModelRuntime();
    const abort = new AbortController();
    const context = {
      signal: abort.signal,
      checkpoint: async () => {
        abort.abort();
      },
    };
    await expect(model.unlock(input.svg, context)).rejects.toThrow();
    const build = vi.spyOn(union, "iteratePressureUnion");
    expect(await model.verifyOutput(input.svg)).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
    const failed = await model.export(
      {
        type: "export-full",
        baseModelRevision: null,
        snapshot: input.snapshot,
        modelRevision: 1,
        sessionId: "proof",
        workerEpoch: 1,
        exportGeneration: 1,
      },
      context,
    );
    expect(failed.ok).toBe(false);
    build.mockClear();
    expect(await model.verifyOutput(input.svg)).not.toBeNull();
    expect(build).not.toHaveBeenCalled();
    await model.unlock(input.svg);
    await expect(model.verifyOutput(input.svg, context)).rejects.toThrow();
    model.initialize(input.snapshot);
    build.mockClear();
    expect(await model.verifyOutput(input.svg)).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("output proof lifetime", () => {
  it("does not republish a proof after clear during a pending unlock", async () => {
    const input = source();
    const model = new DocumentModelRuntime();
    await model.unlock(input.svg, undefined, () => {
      model.clear();
    });
    const build = vi.spyOn(union, "iteratePressureUnion");
    expect(await model.verifyOutput(input.svg)).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("falls back after clear during a proof hash and rejects cancellation", async () => {
    const input = source();
    const model = new DocumentModelRuntime();
    await model.unlock(input.svg);
    const build = vi.spyOn(union, "iteratePressureUnion");
    let cleared = false;
    const result = await model.verifyOutput(input.svg, {
      signal: new AbortController().signal,
      checkpoint: async () => {
        if (!cleared) {
          cleared = true;
          model.clear();
        }
      },
    });
    expect(result?.revision).toBe(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(await model.verifyOutput(input.svg)).not.toBeNull();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
