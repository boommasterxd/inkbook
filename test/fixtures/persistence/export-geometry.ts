import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createTestStroke, createWorkerSnapshot } from "./worker-snapshot";

/** Complete saved SVG with 10,000 separated strokes for export work contracts. */
export function createCapacityExportSvg(pressureEnabled = false): string {
  const stroke = createTestStroke();
  const snapshot = createWorkerSnapshot(
    Array.from({ length: 10_000 }, (_, index) => ({
      ...stroke,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      style: { ...stroke.style, pressureEnabled },
      points: [10, index * 10 + 10, 1, 20, index * 10 + 15, 1],
    })),
  );
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.message);
  return serialized.value.svg;
}
