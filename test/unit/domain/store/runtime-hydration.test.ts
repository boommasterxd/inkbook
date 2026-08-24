import { describe, expect, it } from "vitest";

import { validateInkElementV1, type InkElementV1 } from "../../../../src/domain/schema/public";
import {
  immutableElement,
  mutableElement,
  takeImmutableElementOwnership,
} from "../../../../src/domain/store/immutability";
import { rotateSelection, scaleSelectionUniform } from "../../../../src/editor/selection/public";

import {
  hydrateRuntimeStroke,
  runtimeStrokeHydrationFixture,
} from "../../../fixtures/domain/runtime-stroke-store";
import { highlighter } from "./fixtures";

describe("runtime element ownership", () => {
  it("copies typed samples for ordinary immutability and adopts explicit ownership", () => {
    const source = highlighter();
    const points = new Float64Array(source.points);
    const runtime = { ...source, points } as unknown as InkElementV1;

    const copied = immutableElement(runtime);
    if (copied.kind !== "stroke") throw new Error("Expected stroke record.");
    expect(copied.points).toBeInstanceOf(Float64Array);
    expect(copied.points).not.toBe(points);
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.points)).toBe(false);

    const mutable = mutableElement(copied);
    if (mutable.kind !== "stroke") throw new Error("Expected mutable stroke.");
    expect(mutable.points).toBeInstanceOf(Float64Array);
    expect(mutable.points).not.toBe(copied.points);

    const adopted = takeImmutableElementOwnership(runtime);
    if (adopted.kind !== "stroke") throw new Error("Expected adopted stroke.");
    expect(adopted.points).toBe(points);
    expect(Object.isFrozen(adopted)).toBe(true);
    expect(Object.isFrozen(adopted.points)).toBe(false);
  });

  it("adopts validated runtime stroke buffers without copying them", async () => {
    const source = highlighter();
    const { builder, points, runtime } = runtimeStrokeHydrationFixture(source);

    expect(validateInkElementV1(runtime).ok).toBe(false);
    expect(await builder.appendOwnedRuntime([runtime])).toBe("accepted");
    const store = await builder.finalize();
    const stored = store?.get(source.id)?.element;

    expect(stored?.kind).toBe("stroke");
    if (stored?.kind !== "stroke") throw new Error("Expected hydrated stroke.");
    expect(stored.points).toBe(points);
    expect(Array.from(stored.points)).toEqual(source.points);
  });

  it("accepts scaled and rotated replacements derived from a runtime stroke buffer", async () => {
    const source = highlighter();
    const { store, stroke: stored } = await hydrateRuntimeStroke(source);

    const scaled = scaleSelectionUniform([stored], { x: 0, y: 0 }, 2)[0]!;
    expect(scaled.kind === "stroke" && scaled.points).toBeInstanceOf(Float64Array);
    expect(() => store.replace(source.id, scaled)).not.toThrow();

    const rotated = rotateSelection(
      [store.get(source.id)!.element as InkElementV1],
      { x: 0, y: 0 },
      90,
    )[0]!;
    expect(() => store.replace(source.id, rotated)).not.toThrow();
    expect(store.instrumentation.publishedDeltas).toBe(2);
  });
});
