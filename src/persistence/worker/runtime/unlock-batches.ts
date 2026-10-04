import type { InkElementV1, SnapshotValidationDerivations } from "../../../domain/schema/public";
import type { DocumentRuntimeRequest, DocumentRuntimeObserver, UnlockRuntimeBatch } from "./types";
import {
  MAX_UNLOCK_BATCH_ELEMENTS,
  MAX_UNLOCK_BATCH_POINT_BYTES,
  strokePointByteLength,
} from "./unlock-batch-limits";

export async function emitUnlockBatches(
  identity: Extract<DocumentRuntimeRequest, { type: "unlock" }>["identity"],
  elements: readonly InkElementV1[],
  derivations: SnapshotValidationDerivations,
  observer: DocumentRuntimeObserver | undefined,
  signal: AbortSignal,
): Promise<number> {
  if (elements.length !== derivations.elements.length) {
    throw new TypeError("Validated element derivations are incomplete.");
  }
  let batchIndex = 0;
  let current: InkElementV1[] = [];
  let currentDerivations = [] as (typeof derivations.elements)[number][];
  let currentBytes = 0;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const elementBytes = strokePointByteLength(element);
    if (
      current.length > 0 &&
      (current.length >= MAX_UNLOCK_BATCH_ELEMENTS ||
        currentBytes + elementBytes > MAX_UNLOCK_BATCH_POINT_BYTES)
    ) {
      await emitUnlockBatch(
        { batchIndex, derivations: currentDerivations, elements: current, identity },
        observer,
        signal,
      );
      batchIndex += 1;
      current = [];
      currentDerivations = [];
      currentBytes = 0;
    }
    current.push(element);
    currentDerivations.push(derivations.elements[index]!);
    currentBytes += elementBytes;
  }
  if (current.length > 0) {
    await emitUnlockBatch(
      { batchIndex, derivations: currentDerivations, elements: current, identity },
      observer,
      signal,
    );
    batchIndex += 1;
  }
  return batchIndex;
}

async function emitUnlockBatch(
  batch: UnlockRuntimeBatch,
  observer: DocumentRuntimeObserver | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await observer?.unlockBatch(batch, signal);
}
