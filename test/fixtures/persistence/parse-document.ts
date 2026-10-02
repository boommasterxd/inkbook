import { ChunkedInkbookInputParser } from "../../../src/persistence/serialization/chunked-input-codec";
import type {
  DocumentCodecResult,
  ParsedInkbookDocument,
} from "../../../src/persistence/serialization/types";

const encoder = new TextEncoder();

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
