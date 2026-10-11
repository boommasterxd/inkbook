import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";

/** Independent normalized ownership for cross-store preparation isolation tests. */
export function isolatedStrokePreparationStores(source: StrokeElementV1) {
  const first = new ElementStore([source]);
  const second = new ElementStore([source]);
  const version = first.get(source.id)!.geometryVersion;
  const port = first.pressureGeometry(source.id, version);
  return { first, second, version, port };
}

export async function hydrateRuntimeStroke(source: StrokeElementV1): Promise<{
  readonly points: Float64Array;
  readonly store: ElementStore;
  readonly stroke: StrokeElementV1;
}> {
  const { builder, points } = runtimeStrokeHydrationFixture(source);
  const runtime = { ...source, points } as unknown as InkElementV1;
  await builder.appendOwnedRuntime([runtime]);
  const store = await builder.finalize();
  const stroke = store?.get(source.id)?.element;
  if (store === null || stroke?.kind !== "stroke") {
    throw new Error("Expected a hydrated runtime stroke.");
  }
  return { points, store, stroke: stroke as unknown as StrokeElementV1 };
}

export function runtimeStrokeHydrationFixture(source: StrokeElementV1) {
  const points = new Float64Array(source.points);
  const runtime = { ...source, points } as unknown as InkElementV1;
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  return { builder, points, runtime };
}
