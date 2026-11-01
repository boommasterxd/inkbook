import { ChunkedInkbookInputParser } from "../../../src/persistence/serialization/input/chunked-input-codec";
import type { InkSnapshotV1 } from "../../../src/domain/schema/types";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import type {
  DocumentCodecResult,
  ParsedInkbookDocument,
} from "../../../src/persistence/serialization/types";

const encoder = new TextEncoder();

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
