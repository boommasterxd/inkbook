import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { changedElementDerivations } from "../../../src/obsidian/embeds/vault-document-model-delta";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture, replaceFirstStroke } from "./fixtures";
import { measureAsync } from "./metrics";

const snapshot = createStandardPersistenceFixture();

describe("document worker export performance", () => {
  it("reports unlock and incremental-save phases while reusing validated bounds", async ({
    annotate,
  }) => {
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime({ sessionId: "phases", workerEpoch: 1 });
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
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
          await builder.appendOwnedValidatedRuntime(batch.elements, batch.derivations);
        },
      },
    );
    expect(unlocked.type).toBe("unlock-success");
    const finalized = await measureAsync(() => builder.finalize());
    if (finalized.value === null) throw new Error("Store hydration was cancelled.");

    const first = snapshot.elements[0]!;
    const changed = { ...replaceFirstStroke(snapshot, 2), createdAt: first.createdAt };
    const delta = finalized.value.replace(changed.id, changed);
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
    await annotate(
      `unlock phases=${JSON.stringify(runtime.instrumentation.lastUnlockPhases)}, ` +
        `storeFinalizeMs=${finalized.durationMs.toFixed(1)}, ` +
        `save phases=${JSON.stringify(runtime.instrumentation.lastExportPhases)}`,
      "performance",
    );
    runtime.terminate();
  }, 120_000);
});
