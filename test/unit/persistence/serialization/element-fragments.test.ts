import { afterEach, describe, expect, it, vi } from "vitest";

import { escapeXmlText } from "../../../../src/persistence/documents/xml-text";
import { buildElementFragments } from "../../../../src/persistence/serialization/element-fragments";
import { ElementFragmentCache } from "../../../../src/persistence/serialization/element-fragment-cache";
import { createAllElementSnapshot } from "./fixtures";
import { arrow } from "../../domain/schema/fixtures";
import { coordinateSystem } from "../../domain/geometry/fixtures";
import { serializeElementPaths } from "../../../../src/persistence/serialization/path-markup";

afterEach(() => vi.restoreAllMocks());

it.each(["solid", "dashed", "dotted"] as const)(
  "serializes symmetric open heads with their %s shaft and axis paint",
  (outlineStyle) => {
    const elements = [
      { ...arrow(), startNode: "arrow" as const, endNode: "arrow" as const },
      coordinateSystem("2d"),
      coordinateSystem("3d"),
    ];
    for (const element of elements) {
      element.style = { ...element.style, outlineStyle };
      const paths = serializeElementPaths(element);
      expect(paths).toHaveLength(1);
      const body = paths[0];
      expect(body).toContain('stroke-linecap="round"');
      expect(body?.includes("stroke-dasharray")).toBe(outlineStyle !== "solid");
    }
  },
);

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
      expect(fragment.metadataUtf8).toEqual(encoder.encode(fragment.metadata));
      expect(fragment.svgUtf8).toEqual(encoder.encode(fragment.svg));
      expect(fragment.bytes).toBe(encoder.encode(fragment.metadata + fragment.svg).byteLength);
      expect(fragment.retainedBytes).toBe(
        fragment.bytes +
          (fragment.metadata === fragment.canonicalMetadata ? 0 : fragment.canonicalMetadataBytes),
      );
      expect(fragment.metadataUtf8 === fragment.canonicalMetadataUtf8).toBe(
        fragment.metadata === fragment.canonicalMetadata,
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

  it("adopts byte-backed fragments without materializing their presentation strings", () => {
    const element = createAllElementSnapshot().elements[0]!;
    const fragment = buildElementFragments(element);
    const cache = new ElementFragmentCache();
    cache.replace(element.id, fragment);
    const adopted = structuredClone(element);
    const metadata = vi.spyOn(fragment, "metadata", "get");
    const svg = vi.spyOn(fragment, "svg", "get");

    cache.adopt(adopted);

    expect(metadata).not.toHaveBeenCalled();
    expect(svg).not.toHaveBeenCalled();
    const current = cache.current(adopted)!;
    expect(current.metadataUtf8).toBe(fragment.metadataUtf8);
    expect(current.svgUtf8).toBe(fragment.svgUtf8);
    expect(typeof Object.getOwnPropertyDescriptor(current, "metadata")?.get).toBe("function");
    expect(typeof Object.getOwnPropertyDescriptor(current, "svg")?.get).toBe("function");
    expect(cache.retainedBytes).toBe(fragment.retainedBytes);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.retainedBytes).toBe(0);
  });
});
