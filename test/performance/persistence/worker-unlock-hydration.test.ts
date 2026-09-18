import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { changedElementDerivations } from "../../../src/obsidian/embeds/vault-document-model-delta";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture, replaceFirstStroke } from "./fixtures";

const snapshot = createStandardPersistenceFixture();

describe("document worker export performance", () => {
  it("bounds unlock batches and incremental-save work while reusing validated bounds", async () => {
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime({ sessionId: "phases", workerEpoch: 1 });
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    let hydratedElements = 0;
    const unlocked = await runtime.execute(
      {
        identity: {
          operationId: 1,
          purpose: "unlock",
          sessionId: "phases",
          workerEpoch: 1,
        },
        input: serialized.value.svg,
        type: "unlock",
      },
      {
        unlockBatch: async (batch) => {
          expect(batch.elements.length).toBeGreaterThan(0);
          expect(batch.elements.length).toBeLessThanOrEqual(256);
          const pointBytes = batch.elements.reduce(
            (bytes, element) => bytes + (element.kind === "stroke" ? element.points.length * 8 : 0),
            0,
          );
          expect(pointBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
          hydratedElements += batch.elements.length;
          await builder.appendOwnedValidatedRuntime(batch.elements, batch.derivations);
        },
      },
    );
    expect(unlocked.type).toBe("unlock-success");
    const finalized = await builder.finalize();
    if (finalized === null) throw new Error("Store hydration was cancelled.");

    expect(hydratedElements).toBe(snapshot.elements.length);
    expect(finalized.size).toBe(snapshot.elements.length);
    expect(finalized.instrumentation.hydrationElementVisits).toBe(snapshot.elements.length * 2);
    const first = snapshot.elements[0]!;
    const changed = { ...replaceFirstStroke(snapshot, 2), createdAt: first.createdAt };
    const delta = finalized.replace(changed.id, changed);
    if (delta === null) throw new Error("Expected a changed Store record.");
    const reusesBefore = runtime.instrumentation.derivedBoundsReuses;
    const exported = await runtime.execute({
      baseModelRevision: 1,
      changedElementDerivations: changedElementDerivations(delta),
      changedElements: [changed],
      exportGeneration: 1,
      modelRevision: 2,
      sessionId: "phases",
      type: "export-incremental",
      workerEpoch: 1,
    });
    expect(exported.type).toBe("export-success");
    expect(runtime.instrumentation.derivedBoundsReuses).toBe(reusesBefore + 1);
    runtime.terminate();
  }, 120_000);
});
