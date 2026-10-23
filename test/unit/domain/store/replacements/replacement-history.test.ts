import { afterEach, describe, expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../../src/domain/elements/runtime-sample-copy";
import { elementMutationPayloadBytes } from "../../../../../src/domain/store/mutations/mutation-payload";
import {
  createInitialRecord,
  createReplacementRecord,
} from "../../../../../src/domain/store/records/record-factory";
import { ReplacementHistory } from "../../../../../src/domain/store/replacements/replacement-history";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { observePointReads } from "../../../../fixtures/rendering/point-reads";
import { highlighter } from "../fixtures";

afterEach(() => vi.restoreAllMocks());

function recordPair() {
  const before = createInitialRecord(highlighter());
  if (before.element.kind !== "stroke") throw new Error("Expected a stroke.");
  const after = createReplacementRecord(
    { ...before.element, style: { ...before.element.style, opacity: 0.2 } } as InkElementV1,
    before,
    0,
    1,
  );
  return { before, after };
}

describe("replacement history owned record retention", () => {
  it("retains exact element and record identities with frozen public metadata", () => {
    const { before, after } = recordPair();
    const history = new ReplacementHistory();
    const builder = history.createBuilder();
    builder.append(before, after);
    const data = builder.finish();
    expect(data.previous[0]).toBe(before.element);
    expect(data.replacements[0]).toBe(after.element);
    expect(history.retainedRecord(data.previous[0]!)).toBe(before);
    expect(history.retainedRecord(data.replacements[0]!)).toBe(after);
    expect(data.payloadBytes).toBe(
      64 +
        160 +
        256 +
        elementMutationPayloadBytes(before.element) +
        elementMutationPayloadBytes(after.element),
    );
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.previous)).toBe(true);
    expect(Object.isFrozen(data.replacements)).toBe(true);
    expect(Object.keys(data).sort()).toEqual(["payloadBytes", "previous", "replacements"]);
  });

  it("accepts only exact registered identities from the same owning instance", () => {
    const { before, after } = recordPair();
    const history = new ReplacementHistory();
    const builder = history.createBuilder();
    builder.append(before, after);
    builder.finish();
    expect(history.retainedRecord({ ...before.element })).toBeUndefined();
    expect(new ReplacementHistory().retainedRecord(before.element)).toBeUndefined();
    expect(history.retainedRecord(highlighter())).toBeUndefined();
  });

  it("counts each directional reference but each actual record only once per builder", () => {
    const { before, after } = recordPair();
    const history = new ReplacementHistory();
    const builder = history.createBuilder();
    builder.append(before, after);
    builder.append(after, before);
    const data = builder.finish();
    expect(data.previous).toEqual([before.element, after.element]);
    expect(data.payloadBytes).toBe(
      64 +
        320 +
        256 +
        elementMutationPayloadBytes(before.element) +
        elementMutationPayloadBytes(after.element),
    );
    const next = history.createBuilder();
    next.append(before, after);
    expect(next.finish().payloadBytes).toBe(data.payloadBytes - 160);
  });

  it("ignores identical records and conservatively retains distinct version wrappers", () => {
    const { before } = recordPair();
    const history = new ReplacementHistory();
    const empty = history.createBuilder();
    empty.append(before, before);
    expect(empty.finish()).toEqual({ previous: [], replacements: [], payloadBytes: 64 });
    expect(history.retainedRecord(before.element)).toBeUndefined();
    const after = Object.freeze({ ...before, paintVersion: 5 });
    const builder = history.createBuilder();
    builder.append(before, after);
    expect(builder.finish().payloadBytes).toBe(
      64 + 160 + 256 + 2 * elementMutationPayloadBytes(before.element),
    );
    expect(history.retainedRecord(before.element)).toBe(after);
  });
});

describe("replacement history sample work", () => {
  it("retains large owned buffers without sample reads or sample-copy allocations", () => {
    let reads = 0;
    const points = observePointReads(
      Array.from({ length: 30_000 }, () => 0),
      () => {
        reads += 1;
      },
    );
    const element = { ...highlighter(), points };
    const before = Object.freeze({
      element,
      geometryVersion: 0,
      paintVersion: 0,
      bounds: Object.freeze({ minX: 0, minY: 0, maxX: 200, maxY: 300 }),
    });
    const after = Object.freeze({
      ...before,
      element: { ...element, style: { ...element.style, opacity: 0.2 } },
      paintVersion: 1,
    });
    const copy = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const history = new ReplacementHistory();
    const builder = history.createBuilder();
    builder.append(before, after);
    const data = builder.finish();
    expect(reads).toBe(0);
    expect(copy).not.toHaveBeenCalled();
    expect(data.previous[0]?.kind === "stroke" && data.previous[0].points).toBe(points);
    expect(data.replacements[0]?.kind === "stroke" && data.replacements[0].points).toBe(points);
  });
});
