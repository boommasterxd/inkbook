import { afterEach, describe, expect, it, vi } from "vitest";
import type { InkSnapshotV1 } from "../../../src/domain/schema/public";

import * as geometry from "../../../src/domain/geometry/element-path";
import { createAllElementSnapshot } from "../../unit/persistence/serialization/fixtures";
import * as pathMarkup from "../../../src/persistence/serialization/path-markup";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { StreamingStaticIntegrityMatcher } from "../../../src/persistence/serialization/streaming-static-integrity";
import { createPressureGroupFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("pressure-group static integrity performance", () => {
  it("verifies 10,000 pressure groups through bounded input chunks", () => {
    const snapshot = createPressureGroupFixture();
    expect(snapshot.elements).toHaveLength(10_000);
    const serialized = serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" });
    if (!serialized.ok) throw new Error(serialized.error.code);
    const current = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    expect(current.match(/<g opacity=/gu)).toHaveLength(10_000);
    const fragments = vi.spyOn(pathMarkup, "serializeParts");
    const builds = vi.spyOn(geometry, "buildElementPathParts");
    const matcher = new StreamingStaticIntegrityMatcher(snapshot, serialized.value.lockedHeight);
    expect(fragments).not.toHaveBeenCalled();
    for (let offset = 0; offset < current.length; offset += 16 * 1024) {
      expect(matcher.write(current.slice(offset, offset + 16 * 1024))).toBe(true);
      if (offset === 0) expect(fragments.mock.calls.length).toBeLessThan(10_000);
    }
    expect(matcher.finish()).toBe(true);
    expect(fragments).toHaveBeenCalledTimes(10_000);
    expect(builds).toHaveBeenCalledTimes(10_000);
    builds.mockRestore();
    fragments.mockRestore();
  }, 120_000);
});

const arrowCases = [
  { nodes: ["arrow", "arrow"], style: "dashed" },
  { nodes: ["triangle", "circle"], style: "dashed" },
  { nodes: ["none", "none"], style: "dashed" },
  { nodes: ["none", "none"], style: "dotted" },
] as const;

it.each(arrowCases)(
  "builds only current geometry once for 10,000 $style $nodes arrows",
  ({ nodes, style }) => {
    const snapshot: InkSnapshotV1 = createPressureGroupFixture();
    const arrow = createAllElementSnapshot().elements.find((element) => element.kind === "arrow")!;
    snapshot.elements = snapshot.elements.map((element) => ({
      ...arrow,
      id: element.id,
      startNode: nodes[0],
      endNode: nodes[1],
      style: { ...arrow.style, outlineStyle: style },
    }));
    const serialized = serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" });
    if (!serialized.ok) throw new Error(serialized.error.code);
    const suffix = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    const builds = vi.spyOn(geometry, "buildElementPathParts");
    const matcher = new StreamingStaticIntegrityMatcher(snapshot, serialized.value.lockedHeight);
    expect(builds).not.toHaveBeenCalled();
    for (let offset = 0; offset < suffix.length; offset += 16 * 1024) {
      expect(matcher.write(suffix.slice(offset, offset + 16 * 1024))).toBe(true);
      if (offset === 0) expect(builds.mock.calls.length).toBeLessThan(10_000);
    }
    expect(matcher.finish()).toBe(true);
    expect(builds).toHaveBeenCalledTimes(10_000);
    builds.mockRestore();
  },
  120_000,
);
