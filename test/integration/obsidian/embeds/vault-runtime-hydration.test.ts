import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { loadVaultDocument } from "../../../../src/obsidian/embeds/vault-document-loader";
import { commitVaultPage } from "../../../../src/obsidian/embeds/vault-document-model";
import type { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

const TestTFile = TFile as unknown as new (path: string, size: number) => TFile;

function strokeSnapshot(): InkSnapshotV1 {
  return createWorkerSnapshot([createTestStroke()]);
}

describe("vault runtime hydration", () => {
  it("adopts the worker-owned stroke buffer into the store without a back-copy", async () => {
    const source = strokeSnapshot();
    source.page.background = { spacing: 50, type: "dots" };
    const serialized = serializeInkbookDocument(source);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const bytes = new TextEncoder().encode(serialized.value.svg);
    const file = new TestTFile("drawings/ink.svg", bytes.byteLength);
    const runtime = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });

    const loaded = await loadVaultDocument({
      cancelled: () => false,
      documentId: file.path,
      executor: runtime,
      operation: {
        documentId: file.path,
        operationId: 1,
        sessionId: "session-a",
        workerEpoch: 1,
        workspaceToken: 1,
      },
      purpose: "unlock",
      scheduler: (isCancelled) => ({
        isCancelled,
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
      files: {
        readBinaryForUnlock: async () => ({
          bytes: bytes.buffer.slice(0),
          path: file.path,
          size: bytes.byteLength,
        }),
      },
      workerEpoch: 1,
    });
    if (loaded === undefined) throw new Error("Expected a hydrated runtime document.");

    const snapshotElement = loaded.snapshot.elements[0];
    const storedElement = loaded.store.get(snapshotElement?.id ?? "")?.element;
    expect(snapshotElement?.kind).toBe("stroke");
    expect(storedElement?.kind).toBe("stroke");
    if (snapshotElement?.kind !== "stroke" || storedElement?.kind !== "stroke") {
      throw new Error("Expected a hydrated runtime stroke.");
    }
    const prepared = loaded.store
      .pressureGeometry(storedElement.id, loaded.store.get(storedElement.id)!.geometryVersion)
      .readPath?.();
    expect(prepared).toHaveLength(1);
    expect(serialized.value.svg).toContain(`d="${prepared![0]!.d}"`);
    expect(snapshotElement.points).toBeInstanceOf(Float64Array);
    expect(storedElement.points).toBe(snapshotElement.points);
    expect(Array.from(storedElement.points)).toEqual([10, 10, 0.5, 20, 20, 1]);

    const committed = vi.fn();
    const recordCommit = vi.fn();
    expect(() =>
      commitVaultPage({
        autosave: { recordCommit } as unknown as AutosaveCoordinator,
        commit: committed,
        page: {
          ...loaded.snapshot.page,
          background: { spacing: 50, type: "squares" },
        },
        revision: loaded.snapshot.revision,
        store: loaded.store,
      }),
    ).not.toThrow();
    expect(committed).toHaveBeenCalledWith({
      page: {
        ...loaded.snapshot.page,
        background: { spacing: 50, type: "squares" },
      },
      revision: loaded.snapshot.revision + 1,
    });
    expect(recordCommit).toHaveBeenCalledWith({
      modelRevision: loaded.snapshot.revision + 1,
      page: {
        ...loaded.snapshot.page,
        background: { spacing: 50, type: "squares" },
      },
    });
    runtime.terminate();
  });
});
