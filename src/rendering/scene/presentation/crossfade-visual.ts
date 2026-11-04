import type { CrossfadeMotion, MotionEntry } from "./scene-motion-types";
import { writeMotionVisual, type MotionVisual } from "./motion-visual";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";
import type { SceneStoreDelta } from "../types";

interface CrossfadeTarget {
  readonly id: number;
  readonly elements: readonly InkElementV1[];
  readonly content: Pick<SceneContentRenderer, "hasMounted" | "setElementMotion">;
}

export function crossfadeRetarget(
  change: SceneStoreDelta["affected"][number],
  current: MotionEntry | undefined,
  enabled: boolean,
): { readonly element: InkElementV1; readonly entry: CrossfadeMotion } | undefined {
  if (
    !enabled ||
    current?.kind !== "crossfade" ||
    change.before == null ||
    change.after == null ||
    !change.domains.includes("paint") ||
    change.domains.includes("geometry")
  )
    return undefined;
  return { element: change.before, entry: current };
}

/** Prepare one complete replacement, keeping the previous entry owned until admission succeeds. */
export function createCrossfadeMotion(
  { id, elements: candidates, content }: CrossfadeTarget,
  createVisual: (elements: readonly InkElementV1[], retaining: boolean) => MotionVisual,
  previous?: CrossfadeMotion,
): CrossfadeMotion | undefined {
  const elements = candidates.filter(({ id }) => content.hasMounted(id));
  if (elements.length === 0) return undefined;
  if (previous?.progress === 0) return { ...previous, id, startTime: undefined };
  const current = createVisual(elements, previous !== undefined);
  if (current.nodes.length === 0) return undefined;
  const visual = previous === undefined ? current : retargetCrossfadeVisual(previous, current);
  const entry: CrossfadeMotion = {
    id,
    ids: elements.map((element) => element.id),
    kind: "crossfade",
    progress: 0,
    startTime: undefined,
    visual,
  };
  content.setElementMotion(entry.ids, 0);
  return entry;
}

/** Transfer the painted composite without rebuilding its retained geometry or nesting groups. */
function retargetCrossfadeVisual(previous: CrossfadeMotion, current: MotionVisual): MotionVisual {
  const retained = previous.visual;
  const anchor = retained.targets[0]?.node;
  for (const target of retained.targets) target.opacity = target.renderedOpacity;
  writeMotionVisual(current, previous.progress, 1);
  for (const target of current.targets) {
    target.opacity = target.renderedOpacity;
    if (anchor !== undefined) anchor.parentNode?.insertBefore(target.node, anchor);
  }
  return {
    bytes: retained.bytes + current.bytes,
    nodes: [...current.nodes, ...retained.nodes],
    targets: [...current.targets, ...retained.targets],
  };
}
