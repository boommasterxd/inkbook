import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { loadVaultDocument } from "../../../../src/obsidian/embeds/vault-document-loader";
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
    const serialized = serializeInkbookDocument(strokeSnapshot());
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

    const snapshotElement = loaded?.snapshot.elements[0];
    const storedElement = loaded?.store.get(snapshotElement?.id ?? "")?.element;
    expect(snapshotElement?.kind).toBe("stroke");
    expect(storedElement?.kind).toBe("stroke");
    if (snapshotElement?.kind !== "stroke" || storedElement?.kind !== "stroke") {
      throw new Error("Expected a hydrated runtime stroke.");
    }
    expect(snapshotElement.points).toBeInstanceOf(Float64Array);
    expect(storedElement.points).toBe(snapshotElement.points);
    expect(Array.from(storedElement.points)).toEqual([10, 10, 0.5, 20, 20, 1]);
    runtime.terminate();
  });
});
