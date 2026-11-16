import { ChunkedInkbookInputParser } from "../../../src/persistence/serialization/input/chunked-input-codec";
import { expect } from "vitest";
import { validateSafeSvg } from "../../../src/persistence/documents/safe-svg-validator";
import type { InkSnapshotV1 } from "../../../src/domain/schema/types";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import type {
  DocumentCodecResult,
  ParsedInkbookDocument,
  SerializedInkbookDocument,
} from "../../../src/persistence/serialization/types";

const encoder = new TextEncoder();

/** Checks the standalone presentation and complete editable snapshot through the real parser. */
export async function expectDocumentRoundTrip(saved: SerializedInkbookDocument): Promise<void> {
  expect(validateSafeSvg(saved.svg)).not.toBeNull();
  const parsed = await parseInkbookDocumentForTest(saved.svg);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.value.snapshot).toEqual(saved.snapshot);
}

export async function roundTripInkbookSnapshotForTest(
  snapshot: InkSnapshotV1,
): Promise<InkSnapshotV1> {
  const saved = serializeInkbookDocument(snapshot);
  if (!saved.ok) throw new Error(saved.error.message);
  const loaded = await parseInkbookDocumentForTest(saved.value.svg);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value.snapshot;
}

export async function parseInkbookDocumentForTest(
  input: string | Uint8Array,
): Promise<DocumentCodecResult<ParsedInkbookDocument>> {
  const parser = new ChunkedInkbookInputParser();
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const write = await parser.write(bytes);
  if (!write.ok) return write;
  const parsed = await parser.finish();
  if (!parsed.ok) return parsed;
  return {
    ...parsed,
    value: {
      ...parsed.value,
      snapshot: {
        ...parsed.value.snapshot,
        elements: parsed.value.snapshot.elements.map((element) =>
          element.kind === "stroke" ? { ...element, points: Array.from(element.points) } : element,
        ),
      },
    },
  };
}
