import { afterEach, describe, expect, it, vi } from "vitest";
import * as union from "../../../../../src/domain/geometry/pressure-union";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/document-codec";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import { createAllElementSnapshot } from "../../serialization/fixtures";
import { isDocumentRuntimeWireResult } from "../../../../../src/persistence/worker/runtime/wire-codec";

afterEach(() => vi.restoreAllMocks());

describe("prepared paths from strict unlock verification", () => {
  it("reuses the one actual union computation without exporting unverified file paths", async () => {
    const build = vi.spyOn(union, "iteratePressureUnion");
    const source = serializeInkbookDocument(createAllElementSnapshot());
    if (!source.ok) throw new Error(source.error.code);
    const expectedBuilds = build.mock.calls.length;
    expect(expectedBuilds).toBeGreaterThan(0);
    build.mockClear();
    const result = await new DocumentModelRuntime().unlock(source.value.svg);
    expect(build).toHaveBeenCalledTimes(expectedBuilds);
    expect(result.preparedPaths).toHaveLength(1);
    expect(source.value.svg).toContain(`d="${result.preparedPaths[0]!.geometry[0]!.d}"`);
    expect(isDocumentRuntimeWireResult({ ...result, type: "unlock-success" })).toBe(true);
    expect(
      isDocumentRuntimeWireResult({
        ...result,
        preparedPaths: [{ id: "bad" }],
        type: "unlock-success",
      }),
    ).toBe(false);
  });

  it("does not return prepared geometry when later static integrity fails or unlock is cancelled", async () => {
    const source = serializeInkbookDocument(createAllElementSnapshot());
    if (!source.ok) throw new Error(source.error.code);
    const model = new DocumentModelRuntime();
    await expect(
      model.unlock(source.value.svg.replace("</svg>", "<script/></svg>")),
    ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(
      model.unlock(source.value.svg, {
        signal: abort.signal,
        checkpoint: () => Promise.resolve(),
      }),
    ).rejects.toThrow();
    expect((await model.unlock(source.value.svg)).preparedPaths).toHaveLength(1);
  });
});
