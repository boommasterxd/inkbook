import type { BoxShapeElementV1, InkSnapshotV1 } from "../../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";

const ELEMENT_ID = "00000000-0000-4000-8000-000000000001";
export const executor = { sessionId: "session-a", workerEpoch: 3 } as const;
export const unlockIdentity = {
  ...executor,
  operationId: 1,
  purpose: "unlock" as const,
};

export async function unlockedRuntime(): Promise<DocumentWorkerRuntime> {
  const serialized = serializeInkbookDocument(snapshot());
  if (!serialized.ok) throw new Error(serialized.error.code);
  const runtime = new DocumentWorkerRuntime(executor);
  await runtime.execute({ identity: unlockIdentity, input: serialized.value.svg, type: "unlock" });
  return runtime;
}

export async function expectClipboardEncodeSuccess(
  runtime: DocumentWorkerRuntime,
  basisRevision: number,
): Promise<void> {
  await expect(
    runtime.execute({
      basisRevision,
      identity: { ...executor, operationId: 3, purpose: "clipboard" },
      selectedIds: [rectangle().id],
      type: "clipboard-encode",
    }),
  ).resolves.toMatchObject({ result: { ok: true }, type: "clipboard-encode-success" });
}

export function rectangle(x = 100): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: 80,
    id: ELEMENT_ID,
    kind: "rectangle",
    pivot: { x: x + 50, y: 140 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 100,
    x,
    y: 100,
  };
}

export function snapshot(revision = 0, x = 100): InkSnapshotV1 {
  return {
    elements: [rectangle(x)],
    format: "inkbook",
    page: {
      activeBufferLines: 3,
      background: { spacing: 50, type: "lines" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    revision,
    version: 1,
  };
}

export function rectangleDocument(elementCount: number): InkSnapshotV1 {
  return {
    ...snapshot(),
    elements: Array.from({ length: elementCount }, (_, index) => ({
      ...rectangle(),
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    })),
  };
}
import { expect } from "vitest";
