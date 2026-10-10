import { afterEach, describe, expect, it, vi } from "vitest";

import { escapeXmlText } from "../../../../src/persistence/documents/xml-text";
import { buildElementFragments } from "../../../../src/persistence/serialization/element-fragments";
import { ElementFragmentCache } from "../../../../src/persistence/serialization/element-fragment-cache";
import { createAllElementSnapshot } from "./fixtures";
import { arrow } from "../../domain/schema/fixtures";
import { coordinateSystem } from "../../domain/geometry/fixtures";
import { serializeElementPaths } from "../../../../src/persistence/serialization/path-markup";
import { SampleBase64Writer } from "../../../../src/persistence/serialization/sample-base64";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";

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
  it("accounts for owned stroke range descriptors and releases their cache entry", () => {
    const stroke = createTestStroke();
    const fragment = buildElementFragments(stroke);
    const cache = new ElementFragmentCache();
    expect(fragment.strokePaths).toHaveLength(1);
    expect(fragment.retainedBytes).toBe(
      fragment.bytes +
        (fragment.metadataUtf8 === fragment.canonicalMetadataUtf8
          ? 0
          : fragment.canonicalMetadataBytes) +
        48 +
        64 * fragment.strokePaths!.length,
    );
    cache.replace(stroke.id, fragment);
    expect(cache.retainedBytes).toBe(fragment.retainedBytes);
    cache.remove(stroke.id);
    expect(cache.retainedBytes).toBe(0);
  });

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
          (fragment.metadata === fragment.canonicalMetadata ? 0 : fragment.canonicalMetadataBytes) +
          (fragment.strokePaths === undefined ? 0 : 48 + 64 * fragment.strokePaths.length),
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

describe("owned runtime fragment adoption", () => {
  it.each([false, true])(
    "reuses exact samples with a fresh buffer=%s without encoding or decoding",
    (fresh) => {
      const source = runtimeStroke();
      const fragment = buildElementFragments(source);
      const cache = new ElementFragmentCache();
      cache.adopt(source, true);
      cache.replace(source.id, fragment);
      const adopted = fresh ? structuredClone(source) : { ...source };
      const append = vi.spyOn(SampleBase64Writer.prototype, "append");
      const decode = vi.spyOn(TextDecoder.prototype, "decode");

      cache.adopt(adopted, true);

      expect(append).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(cache.current(adopted)?.metadataUtf8).toBe(fragment.metadataUtf8);
      expect(cache.current(adopted)?.svgUtf8).toBe(fragment.svgUtf8);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.retainedBytes).toBe(0);
      cache.replace(source.id, fragment);
      cache.adopt({ ...source }, true);
      expect(append).toHaveBeenCalled();
      cache.clear();
    },
  );

  it.each(Object.entries(runtimeReplacementCases()))(
    "invalidates changed %s metadata exactly",
    (_name, replace) => {
      const source = runtimeStroke();
      const cache = new ElementFragmentCache();
      cache.adopt(source, true);
      cache.replace(source.id, buildElementFragments(source));
      const adopted = replace(structuredClone(source));

      cache.adopt(adopted, true);

      expect(cache.current(adopted)).toBeUndefined();
      expect(cache.retainedBytes).toBe(0);
    },
  );

  it.each([false, true])("rechecks mutable unowned samples with a typed buffer=%s", (typed) => {
    const source = typed ? runtimeStroke() : createTestStroke();
    const cache = new ElementFragmentCache();
    cache.replace(source.id, buildElementFragments(source));
    source.points[0] = source.points[0]! + 0.001;
    const append = vi.spyOn(SampleBase64Writer.prototype, "append");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");

    cache.adopt(source);

    expect(append).toHaveBeenCalled();
    expect(decode).toHaveBeenCalledOnce();
    expect(cache.current(source)).toBeUndefined();
  });

  it("requires previous runtime ownership even when the new record is owned", () => {
    const source = runtimeStroke();
    const cache = new ElementFragmentCache();
    cache.replace(source.id, buildElementFragments(source));
    const append = vi.spyOn(SampleBase64Writer.prototype, "append");

    cache.adopt({ ...source }, true);

    expect(append).toHaveBeenCalled();
    expect(cache.size).toBe(1);
  });

  it("keeps the complete comparison for mutable array samples even with a matching record", () => {
    const source = createTestStroke();
    const cache = new ElementFragmentCache();
    cache.adopt(source, true);
    cache.replace(source.id, buildElementFragments(source));
    source.points[0] = source.points[0]! + 0.001;
    const append = vi.spyOn(SampleBase64Writer.prototype, "append");

    cache.adopt(source, true);

    expect(append).toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });
});

function runtimeReplacementCases(): Record<string, (stroke: StrokeElementV1) => StrokeElementV1> {
  return {
    coordinate: (stroke) => ({ ...stroke, points: changeSample(stroke, 0, 0.001) }),
    pressure: (stroke) => ({ ...stroke, points: changeSample(stroke, 2, 0.0001) }),
    count: (stroke) => ({ ...stroke, points: stroke.points.slice(0, 3) }),
    negativeZero: (stroke) => ({
      ...stroke,
      points: changeSample(stroke, 0, -stroke.points[0]!, -0),
    }),
    offset: (stroke) => ({ ...stroke, offset: { x: 1, y: 0 } }),
    explicitZeroOffset: (stroke) => ({ ...stroke, offset: { x: 0, y: 0 } }),
    width: (stroke) => ({ ...stroke, style: { ...stroke.style, width: 4 } }),
    opacity: (stroke) => ({ ...stroke, style: { ...stroke.style, opacity: 0.5 } }),
    pressureFlag: (stroke) => ({
      ...stroke,
      style: { ...stroke.style, pressureEnabled: !stroke.style.pressureEnabled },
    }),
    color: (stroke) => ({
      ...stroke,
      style: { ...stroke.style, color: { type: "rgba", value: "#FF0000FF" } },
    }),
    tool: (stroke) => ({ ...stroke, tool: "highlighter" }),
    rotation: (stroke) => ({ ...stroke, rotation: 1 }),
    pivot: (stroke) => ({ ...stroke, pivot: { ...stroke.pivot, x: stroke.pivot.x + 1 } }),
    creation: (stroke) => ({ ...stroke, createdAt: stroke.createdAt + 1 }),
  };
}

function runtimeStroke(): StrokeElementV1 {
  const stroke = createTestStroke();
  return { ...stroke, points: new Float64Array(stroke.points) as unknown as typeof stroke.points };
}

function changeSample(
  stroke: StrokeElementV1,
  index: number,
  delta: number,
  value = stroke.points[index]! + delta,
): StrokeElementV1["points"] {
  const points = new Float64Array(stroke.points);
  points[index] = value;
  return points as unknown as StrokeElementV1["points"];
}
