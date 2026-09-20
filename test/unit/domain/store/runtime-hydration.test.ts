import { describe, expect, it } from "vitest";

import { validateInkElementV1, type InkElementV1 } from "../../../../src/domain/schema/public";
import { validateRuntimeInkSnapshotV1 } from "../../../../src/domain/schema/snapshot-validation";
import {
  immutableElement,
  mutableElement,
  takeImmutableElementOwnership,
} from "../../../../src/domain/store/immutability";
import { ElementStore } from "../../../../src/domain/store/public";
import { rotateSelection } from "../../../../src/editor/selection/transforms";

import {
  hydrateRuntimeStroke,
  runtimeStrokeHydrationFixture,
} from "../../../fixtures/domain/runtime-stroke-store";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { scaleSelectionUniformForTest as scaleSelectionUniform } from "../../../fixtures/editor/selection-transform-reference";
import { highlighter, rectangle } from "./fixtures";

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
    expect(() => new ElementStore([runtime])).toThrow(RangeError);
    expect(() => new ElementStore().create(runtime)).toThrow(RangeError);
    expect(await builder.appendOwnedRuntime([runtime])).toBe("accepted");
    const store = await builder.finalize();
    expectHydratedStroke(store, source, points);
  });
});

describe("validated runtime hydration", () => {
  it("batch-adopts validated records with per-element scheduler checkpoints", async () => {
    const target = rectangle();
    const { points, runtime, source, validation } = validatedStrokeFixture([target]);
    let yields = 0;
    const builder = ElementStore.createBuilder({
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expect(
      await builder.appendOwnedValidatedRuntime([runtime, target], validation.derivations.elements),
    ).toBe("accepted");
    const store = await builder.finalize();
    expectHydratedStroke(store, source, points);
    expect(store?.get(target.id)?.element).toEqual(target);
    expect(store?.instrumentation.hydrationYields).toBe(4);
    expect(yields).toBe(4);
  });

  it("rejects duplicate IDs within a validated runtime batch", async () => {
    const { runtime, validation } = validatedStrokeFixture();
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });

    await expect(
      builder.appendOwnedValidatedRuntime(
        [runtime, runtime],
        [validation.derivations.elements[0]!, validation.derivations.elements[0]!],
      ),
    ).rejects.toThrow(RangeError);
    expect(await builder.finalize()).toBeNull();
  });

  it("cancels validated adoption after its final scheduler checkpoint", async () => {
    const { runtime, validation } = validatedStrokeFixture();
    let cancelled = false;
    const builder = ElementStore.createBuilder({
      isCancelled: () => cancelled,
      shouldYield: () => true,
      yieldControl: async () => {
        cancelled = true;
      },
    });

    expect(
      await builder.appendOwnedValidatedRuntime([runtime], validation.derivations.elements),
    ).toBe("cancelled");
    expect(await builder.finalize()).toBeNull();
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

function validatedStrokeFixture(additional: readonly InkElementV1[] = []) {
  const source = highlighter();
  const points = new Float64Array(source.points);
  const runtime = { ...source, points } as unknown as InkElementV1;
  const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot([runtime, ...additional]));
  if (!validation.ok) throw new Error(`Expected valid fixture: ${validation.error.code}`);
  return { points, runtime, source, validation };
}

function expectHydratedStroke(
  store: ElementStore | null,
  source: InkElementV1,
  points: Float64Array,
): void {
  const stored = store?.get(source.id)?.element;
  expect(stored?.kind).toBe("stroke");
  if (stored?.kind !== "stroke" || source.kind !== "stroke") {
    throw new Error("Expected hydrated stroke.");
  }
  expect(stored.points).toBe(points);
  expect(Array.from(stored.points)).toEqual(source.points);
}
