import * as geometry from "../../../src/domain/geometry/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../../src/domain/spatial/index";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import type { InkElementV1, InkSnapshotV1 } from "../../../src/domain/schema/public";
import { verifyVaultUnlockIntegrity } from "../../../src/obsidian/embeds/vault-unlock-integrity";
import * as metadata from "../../../src/persistence/serialization/canonical-metadata";
import * as canonical from "../../../src/persistence/serialization/canonical-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { changedElementDerivations } from "../../../src/obsidian/embeds/vault-document-model-delta";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture, replaceFirstStroke } from "./fixtures";

import * as pressureUnion from "../../../src/domain/geometry/pressure-union";

afterEach(() => vi.restoreAllMocks());

const snapshot = createStandardPersistenceFixture();

describe("document worker export performance", () => {
  it("bounds unlock batches and incremental-save work while reusing validated bounds", async () => {
    const builds = vi.spyOn(pressureUnion, "iteratePressureUnion");
    const serialized = serializeInkbookDocument(snapshot);
    const expectedBuilds = builds.mock.calls.length;
    expect(expectedBuilds).toBeGreaterThan(0);
    builds.mockClear();
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime({ sessionId: "phases", workerEpoch: 1 });
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    let hydratedElements = 0;
    const ownedElements: InkElementV1[] = [];
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
          ownedElements.push(...batch.elements);
          await builder.appendOwnedValidatedRuntime(batch.elements, batch.derivations);
        },
      },
    );
    expect(unlocked.type).toBe("unlock-success");
    expect(builds).not.toHaveBeenCalled();
    if (unlocked.type !== "unlock-success") throw new Error("Unlock failed.");
    const finalized = await builder.finalize();
    if (finalized === null) throw new Error("Store hydration was cancelled.");

    expect(hydratedElements).toBe(snapshot.elements.length);
    expect(finalized.size).toBe(snapshot.elements.length);
    expect(finalized.instrumentation.hydrationElementVisits).toBe(snapshot.elements.length * 2);
    await verifyHydrationProof({ ...snapshot, elements: ownedElements }, finalized);
    await verifyPersistedProof(runtime, serialized.value.svg, expectedBuilds);
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
    if (exported.type !== "export-success") throw new Error("Export failed.");
    builds.mockClear();
    expect(
      (
        await runtime.execute({
          type: "verify-output",
          input: exported.output,
          identity: { operationId: 4, purpose: "read-back", sessionId: "phases", workerEpoch: 1 },
        })
      ).type,
    ).toBe("verify-output-success");
    expect(builds).not.toHaveBeenCalled();
    runtime.terminate();
  }, 120_000);
});

async function verifyHydrationProof(snapshot: InkSnapshotV1, store: ElementStore): Promise<void> {
  const syncHash = vi.spyOn(metadata, "canonicalMetadataSha256");
  const canonicalize = vi.spyOn(canonical, "canonicalElement");
  await verifyVaultUnlockIntegrity({
    snapshot,
    store,
    scheduler: { shouldYield: () => false, yieldControl: async () => undefined },
  });
  expect(syncHash).not.toHaveBeenCalled();
  expect(canonicalize).not.toHaveBeenCalled();
  expect(store.instrumentation.snapshotMaterializations).toBe(0);
  canonicalize.mockRestore();
  syncHash.mockRestore();
}

async function verifyPersistedProof(
  runtime: DocumentWorkerRuntime,
  input: string,
  expectedBuilds: number,
): Promise<void> {
  const builds = vi.spyOn(pressureUnion, "iteratePressureUnion");
  builds.mockClear();
  const identity = {
    sessionId: "phases",
    workerEpoch: 1,
    purpose: "verification" as const,
    operationId: 2,
  };
  expect((await runtime.execute({ type: "verify-output", identity, input })).type).toBe(
    "verify-output-success",
  );
  expect(builds).toHaveBeenCalledTimes(expectedBuilds);
  expect(
    (
      await runtime.execute({
        type: "verify-output",
        identity: { ...identity, operationId: 3 },
        input: input + "\n",
      })
    ).type,
  ).toBe("verify-output-success");
  expect(builds).toHaveBeenCalledTimes(expectedBuilds * 2);
}

describe("complete translated stroke delta work", () => {
  it("bounds canonical capacity and fragment rebuilding for a complete translated stroke delta", () => {
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(snapshot).ok).toBe(true);
    const strokes = snapshot.elements.filter((element) => element.kind === "stroke");
    expect(strokes).toHaveLength(10_000);
    const changedElements = strokes.map((element) =>
      geometry.translateElementGeometry(element, { x: 20, y: 12 }),
    );
    const changedElementDerivations = strokes.map((element) => {
      const previous = geometry.calculateElementBounds(element);
      const bounds = {
        minX: previous.minX + 20,
        maxX: previous.maxX + 20,
        minY: previous.minY + 12,
        maxY: previous.maxY + 12,
      };
      const memberships = spatialCellMembershipCount(bounds);
      return {
        elementId: element.id,
        bounds,
        spatialOverflow: memberships > MAX_ELEMENT_CELLS,
        spatialMemberships: memberships > MAX_ELEMENT_CELLS ? 0 : memberships,
      };
    });
    const fragmentsBefore = serializer.instrumentation.fragmentBuilds;
    const bounds = vi.spyOn(geometry, "calculateElementBounds");
    const builds = vi.spyOn(pressureUnion, "iteratePressureUnion");
    expect(
      serializer.applyDelta({
        baseModelRevision: snapshot.revision,
        modelRevision: snapshot.revision + 1,
        changedElements,
        changedElementDerivations,
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(bounds).toHaveBeenCalledTimes(10_000);
    // Bound the actual pressure-window unions for the shared 500,000-point fixture.
    expect(builds.mock.calls.length).toBeLessThanOrEqual(10_001);
    expect(serializer.instrumentation.fragmentBuilds - fragmentsBefore).toBe(10_000);
    expect(serializer.currentSnapshot()?.revision).toBe(snapshot.revision + 1);
  });
});
