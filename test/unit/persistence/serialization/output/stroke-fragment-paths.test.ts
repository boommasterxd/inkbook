import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { StrokeElementV1 } from "../../../../../src/domain/schema/public";
import type { SvgPathPart } from "../../../../../src/domain/geometry/svg-path-part";
import { buildElementFragments } from "../../../../../src/persistence/serialization/output/element-fragments";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/output/incremental-document-serializer";
import { readStrokeFragmentPaths } from "../../../../../src/persistence/serialization/output/stroke-fragment-paths";
import { StrokeShapeCache } from "../../../../../src/persistence/serialization/output/stroke-shape-cache";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

describe("owned stroke fragment scene reuse", () => {
  it.each(["pressure", "centerline", "point", "translated-rotated"])(
    "returns canonical local %s geometry after the shape cache is cleared",
    async (kind) => {
      const stroke = strokeCase(kind);
      const fixture = exportedStroke(stroke);
      const before = fixture.serializer.instrumentation;

      const actual = await fixture.serializer.prepareScenePath(stroke.id, context());

      expect(actual).toEqual(fixture.parts);
      expect(actual?.[0]?.paint).toBe(kind === "pressure" ? "fill" : "stroke");
      expect(fixture.serializer.instrumentation).toMatchObject({
        cacheBytes: before.cacheBytes,
        cacheElements: 1,
        fragmentBuilds: before.fragmentBuilds,
        shapeBuilds: 0,
        shapeCacheBytes: 0,
        shapeCacheElements: 0,
      });
      if (kind === "pressure") {
        expect(fixture.svg).toContain('opacity="0.3765"');
        expect(fixture.svg).toContain('fill="#336699FF"');
      }
      if (kind === "translated-rotated") {
        expect(fixture.svg).toContain('transform="translate(12.5 25)"');
        const local = strokeCase("centerline");
        const rotated = exportedStroke({ ...local, rotation: stroke.rotation });
        expect(actual).toEqual(rotated.parts);
      }
      fixture.serializer.clear();
      expect(fixture.serializer.instrumentation.cacheBytes).toBe(0);
      await expect(
        fixture.serializer.prepareScenePath(stroke.id, context()),
      ).resolves.toBeUndefined();
    },
  );
});

describe("stroke fragment model lifetime", () => {
  it("rejects a cancelled cache hit before decoding any owned bytes", async () => {
    const fixture = exportedStroke(createTestStroke());
    const controller = new AbortController();
    controller.abort();
    const decode = vi.spyOn(TextDecoder.prototype, "decode");

    await expect(
      fixture.serializer.prepareScenePath(createTestStroke().id, context(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(decode).not.toHaveBeenCalled();
    fixture.serializer.clear();
  });

  it.each(["reset", "clear"])(
    "rejects a retained fragment when %s replaces its current model during a handoff",
    async (operation) => {
      const stroke = createTestStroke();
      const fixture = exportedStroke(stroke);
      const checkpoint = vi.fn(() => {
        if (operation === "clear") fixture.serializer.clear();
        else
          expect(fixture.serializer.resetRuntime(createWorkerSnapshot([stroke], 1)).ok).toBe(true);
        return Promise.resolve();
      });

      await expect(
        fixture.serializer.prepareScenePath(stroke.id, { ...context(), checkpoint }),
      ).rejects.toThrow();

      expect(checkpoint).toHaveBeenCalled();
      expect(fixture.serializer.instrumentation.shapeBuilds).toBe(0);
      fixture.serializer.clear();
    },
  );

  it("prepares changed samples instead of reusing a stale fragment and releases removed paths", async () => {
    const stroke = createTestStroke();
    const fixture = exportedStroke(stroke);
    const changed = { ...stroke, points: [...stroke.points] };
    changed.points[0] = changed.points[0]! + 5;
    expect(
      fixture.serializer.applyDelta({
        baseModelRevision: 0,
        modelRevision: 1,
        changedElements: [changed],
      }).ok,
    ).toBe(true);
    const parts = await fixture.serializer.prepareScenePath(stroke.id, context());
    expect(parts).not.toEqual(fixture.parts);
    expect(fixture.serializer.instrumentation).toMatchObject({ cacheElements: 0, shapeBuilds: 1 });
    expect(
      fixture.serializer.applyDelta({
        baseModelRevision: 1,
        modelRevision: 2,
        removedIds: [stroke.id],
      }).ok,
    ).toBe(true);
    await expect(
      fixture.serializer.prepareScenePath(stroke.id, context()),
    ).resolves.toBeUndefined();
    fixture.serializer.clear();
    expect(fixture.serializer.instrumentation).toMatchObject({ cacheBytes: 0, shapeCacheBytes: 0 });
  });
});

describe("bounded owned fragment decoding", () => {
  let fragment: ReturnType<typeof buildElementFragments>;
  beforeAll(() => {
    const stroke = createTestStroke();
    fragment = buildElementFragments({
      ...stroke,
      points: Array.from({ length: 16_384 }, (_, index) => [
        10 + (index % 1000),
        10 + Math.floor(index / 1000) * 20 + (index % 4 < 2 ? 0 : 10),
        1,
      ]).flat(),
      style: { ...stroke.style, pressureEnabled: false },
    });
    expect(fragment.pathDataBytes).toBeGreaterThan(64 * 1024);
    expect(fragment.strokePaths).toBeDefined();
  });

  it("decodes exactly the retained path bytes in native chunks no larger than 64 KiB", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const parts = await readStrokeFragmentPaths(ownedFragment(), context());
    const nativeBytes = decode.mock.calls.map(([input]) => input?.byteLength ?? 0);

    expect(nativeBytes.reduce((sum, bytes) => sum + bytes, 0)).toBe(fragment.pathDataBytes);
    expect(Math.max(...nativeBytes)).toBeLessThanOrEqual(64 * 1024);
    expect(nativeBytes.filter((bytes) => bytes > 0).length).toBeGreaterThan(1);
    expect(parts[0]?.d.length).toBe(fragment.pathDataBytes);
    expect(parts[0]?.paint).toBe("stroke");
    expect(fragment.retainedBytes).toBeGreaterThan(fragment.bytes);
  });

  it("stops before the next native chunk when cancellation follows a decode", async () => {
    const controller = new AbortController();
    const nativeDecode = TextDecoder.prototype.decode.bind(new TextDecoder());
    const decode = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation((...args) => {
      const result = nativeDecode(...args);
      controller.abort();
      return result;
    });

    await expect(
      readStrokeFragmentPaths(ownedFragment(), context(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(decode).toHaveBeenCalledOnce();
    expect(decode.mock.calls[0]?.[0]?.byteLength).toBeLessThanOrEqual(64 * 1024);
  });

  it("honors central admission and aborts a suspended decode without reading bytes", async () => {
    const controller = new AbortController();
    const checkpoint = vi.fn(async () => controller.abort());
    const decode = vi.spyOn(TextDecoder.prototype, "decode");

    await expect(
      readStrokeFragmentPaths(ownedFragment(), { signal: controller.signal, checkpoint }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(checkpoint).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });

  function ownedFragment() {
    return { svgUtf8: fragment.svgUtf8, strokePaths: fragment.strokePaths! };
  }
});

function context(signal = new AbortController().signal) {
  return { signal, checkpoint: () => undefined };
}

function exportedStroke(stroke: StrokeElementV1) {
  const serializer = new IncrementalDocumentSerializer();
  const owners = new Set<StrokeShapeCache>();
  let parts: readonly SvgPathPart[] | undefined;
  const resolve = Object.getOwnPropertyDescriptor(StrokeShapeCache.prototype, "resolve")!
    .value as StrokeShapeCache["resolve"];
  const observer = vi.spyOn(StrokeShapeCache.prototype, "resolve").mockImplementation(function (
    this: StrokeShapeCache,
    element,
  ) {
    owners.add(this);
    parts = resolve.call(this, element);
    return parts;
  });
  expect(serializer.resetRuntime(createWorkerSnapshot([stroke])).ok).toBe(true);
  const exported = serializer.serialize();
  observer.mockRestore();
  const cache = owners.values().next().value;
  if (!exported.ok || cache === undefined || parts === undefined)
    throw new Error("Expected owned export.");
  expect(serializer.instrumentation.cacheElements).toBe(1);
  cache.clear();
  expect(serializer.instrumentation.shapeCacheElements).toBe(0);
  return { serializer, parts, svg: exported.value.svg };
}

function strokeCase(kind: string): StrokeElementV1 {
  const stroke = createTestStroke();
  const style = { ...stroke.style, pressureEnabled: kind === "pressure" };
  if (kind === "pressure") {
    return {
      ...stroke,
      style: { ...style, color: { type: "rgba", value: "#33669980" }, opacity: 0.75 },
    };
  }
  if (kind === "point") return { ...stroke, points: stroke.points.slice(0, 3), style };
  if (kind === "translated-rotated") {
    return {
      ...stroke,
      rotation: 35,
      offset: { x: 12.5, y: 25 },
      pivot: { x: 22.5, y: 35 },
      style,
    };
  }
  return { ...stroke, style };
}
