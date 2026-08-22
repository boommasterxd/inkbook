import { describe, expect, it } from "vitest";

import {
  ChunkedOutputCancelledError,
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import { createAllElementSnapshot } from "./fixtures";

describe("chunked incremental document serialization", () => {
  it("preserves the canonical document bytes while checkpointing assembly and hashing", async () => {
    const snapshot = createAllElementSnapshot();
    const expected = serializeInkbookDocument(snapshot);
    const serializer = new IncrementalDocumentSerializer();
    let checkpoints = 0;
    serializer.reset(snapshot);

    const actual = await serializer.serializeChunked({
      checkpoint: async () => {
        checkpoints += 1;
      },
      sliceByteLimit: 32,
    });

    expect(actual).toEqual(expected);
    expect(checkpoints).toBeGreaterThan(1);
  });

  it("cancels without publishing a partial serialized result", async () => {
    const serializer = new IncrementalDocumentSerializer();
    const controller = new AbortController();
    serializer.reset(createAllElementSnapshot());

    const operation = serializer.serializeChunked({
      checkpoint: async () => controller.abort(),
      signal: controller.signal,
      sliceByteLimit: 16,
    });

    await expect(operation).rejects.toBeInstanceOf(ChunkedOutputCancelledError);
  });
});
