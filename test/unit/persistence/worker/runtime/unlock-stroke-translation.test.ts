import { expect, it } from "vitest";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import { executor, snapshot, STROKE } from "./fixtures";

it("exports the first translated stroke after validated unlock without losing sample proofs", async () => {
  const document = serializeInkbookDocument({ ...snapshot(), elements: [STROKE] });
  if (!document.ok) throw new Error(document.error.message);
  const model = new DocumentModelRuntime();
  const unlocked = await model.unlock(document.value.svg);
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
