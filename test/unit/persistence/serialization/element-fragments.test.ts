import { afterEach, describe, expect, it, vi } from "vitest";

import { escapeXmlText } from "../../../../src/persistence/documents/xml-text";
import { buildElementFragments } from "../../../../src/persistence/serialization/element-fragments";
import { createAllElementSnapshot } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("cached element fragment byte counts", () => {
  it.each(["ascii", 'äß漢字😀<&>"', "\ud800"])(
    "counts canonical and XML-escaped UTF-8 bytes exactly for %j",
    (id) => {
      // Exercise the fragment boundary directly; validated document IDs are UUIDs.
      const element = { ...createAllElementSnapshot().elements[0]!, id };
      const fragment = buildElementFragments(element);
      const encoder = new TextEncoder();

      expect(fragment.metadata).toBe(escapeXmlText(fragment.canonicalMetadata));
      expect(fragment.canonicalMetadataUtf8).toEqual(encoder.encode(fragment.canonicalMetadata));
      expect(fragment.canonicalMetadataBytes).toBe(fragment.canonicalMetadataUtf8.byteLength);
      expect(fragment.metadataBytes).toBe(encoder.encode(fragment.metadata).byteLength);
      expect(fragment.bytes).toBe(encoder.encode(fragment.metadata + fragment.svg).byteLength);
      expect(fragment.retainedBytes).toBe(
        fragment.bytes +
          fragment.canonicalMetadataBytes +
          (fragment.metadata === fragment.canonicalMetadata ? 0 : fragment.canonicalMetadataBytes),
      );
    },
  );

  it("encodes canonical metadata only once when building its hash buffer", () => {
    const element = { ...createAllElementSnapshot().elements[0]!, id: "ä😀<&>" };
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    const fragment = buildElementFragments(element);

    expect(
      encode.mock.calls.filter(([value]) => value === fragment.canonicalMetadata),
    ).toHaveLength(1);
    expect(encode.mock.calls.filter(([value]) => value === fragment.metadata)).toHaveLength(1);
  });
});
