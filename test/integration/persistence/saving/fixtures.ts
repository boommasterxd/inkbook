import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import type { AutosaveDocumentSource } from "../../../../src/persistence/saving/autosave/public";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";

export class AutosaveDocumentFixture implements AutosaveDocumentSource {
  gestureActive = false;
  value: InkSnapshotV1 = snapshot();

  commit(revision: number, x: number): void {
    this.value = { ...this.value, elements: [rectangle(x)], revision };
  }

  currentRevision(): number {
    return this.value.revision;
  }

  isGestureActive(): boolean {
    return this.gestureActive;
  }

  orderByBand() {
    return { content: this.value.elements.map(({ id }) => id) } as const;
  }

  snapshot(): InkSnapshotV1 {
    return this.value;
  }
}

export function serializeSnapshot(value: InkSnapshotV1 = snapshot()) {
  const result = serializeInkbookDocument(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
