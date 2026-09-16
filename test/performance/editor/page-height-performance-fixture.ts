import { expect } from "vitest";
import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import type { ElementStore } from "../../../src/domain/store/public";
import { createStandardRuntimeDomainFixture } from "../domain/standard-domain-fixture";

export function pageHeightPercentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

export async function createPageHeightStore(
  storeClass: typeof ElementStore,
): Promise<ElementStore> {
  const builder = storeClass.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => Promise.resolve(),
  });
  expect(await builder.appendOwnedRuntime(createStandardRuntimeDomainFixture().elements)).toBe(
    "accepted",
  );
  const store = await builder.finalize();
  if (store === null) throw new Error("The page-height fixture was cancelled.");
  return store;
}

export function bottomMarker(index: number, y: number): BoxShapeElementV1 {
  return {
    createdAt: index,
    height: 100,
    id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    kind: "rectangle",
    pivot: { x: 50, y: y + 50 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 100,
    x: 0,
    y,
  };
}
