import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { StrokeShapeCache } from "./stroke-shape-cache";
import type { ElementFragmentCache } from "./element-fragment-cache";
import { consumeSerializationSteps } from "./serialization-model-preparation";
import { readStrokeFragmentPaths } from "./stroke-fragment-paths";

export async function prepareCachedScenePath(
  source: {
    readonly current: (id: string) => InkElementV1 | undefined;
    readonly shapes: StrokeShapeCache;
    readonly fragments: ElementFragmentCache;
  },
  id: string,
  context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
): Promise<readonly SvgPathPart[] | undefined> {
  context.signal.throwIfAborted();
  const element = source.current(id);
  if (element?.kind !== "stroke") return undefined;
  const assertCurrent = () => {
    context.signal.throwIfAborted();
    if (source.current(id) !== element)
      throw new Error("The scene path model changed during preparation.");
  };
  const shape = await consumeSerializationSteps(
    source.shapes.readSteps(element, context.signal),
    context,
  );
  assertCurrent();
  if (shape !== undefined) return shape;
  const fragment = source.fragments.current(element);
  if (fragment?.strokePaths !== undefined) {
    const parts = await readStrokeFragmentPaths(fragment, context);
    assertCurrent();
    source.fragments.touch(id);
    return parts;
  }
  return source.shapes.prepare(element, context);
}
