import { expect, it, vi } from "vitest";
import * as strokeSamples from "../../../../../src/domain/elements/public";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/model/document-model";
import { executor, snapshot, STROKE } from "./fixtures";

it("exports the first translated stroke after validated unlock without losing sample proofs", async () => {
  const document = serializeInkbookDocument({ ...snapshot(), elements: [STROKE] });
  if (!document.ok) throw new Error(document.error.message);
  const model = new DocumentModelRuntime();
  const assertion = vi.spyOn(strokeSamples, "assertStrokeSamplesV1");
  const unlocked = await model.unlock(document.value.svg);
  expect(assertion).not.toHaveBeenCalled();
  assertion.mockRestore();
  const stroke = unlocked.snapshot.elements[0]!;
  if (stroke.kind !== "stroke") throw new Error("Expected an unlocked stroke.");
  const result = await model.export({
    ...executor,
    baseModelRevision: 0,
    modelRevision: 1,
    exportGeneration: 1,
    changedElements: [
      {
        ...stroke,
        offset: { x: 10, y: 10 },
        pivot: { x: stroke.pivot.x + 10, y: stroke.pivot.y + 10 },
      },
    ],
    type: "export-incremental",
  });
  expect(result).toMatchObject({ ok: true });
});

it("uses the same validated source for sliced unlock copying", async () => {
  const document = serializeInkbookDocument({ ...snapshot(), elements: [STROKE] });
  if (!document.ok) throw new Error(document.error.message);
  const assertion = vi.spyOn(strokeSamples, "assertStrokeSamplesV1");
  try {
    const model = new DocumentModelRuntime();
    const result = await model.unlock(document.value.svg, {
      checkpoint: async () => {},
      signal: new AbortController().signal,
      workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
    });
    expect(result.snapshot.elements[0]?.kind).toBe("stroke");
    expect(assertion).not.toHaveBeenCalled();
  } finally {
    assertion.mockRestore();
  }
});
