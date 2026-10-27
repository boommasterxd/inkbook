import type { MountedSceneElement } from "../content/mounted-element";
import { firstPath } from "../content/mounted-element";
import type { SceneDom } from "../scene-dom";

export interface SceneRootTarget {
  readonly parent: SVGGElement;
  readonly before: SVGElement | null;
}

/** The run owner resolves physical placement; publication retains logical Store order. */
export interface SceneRootPlacement {
  placement(
    entry: MountedSceneElement,
    successor: MountedSceneElement | undefined,
  ): SceneRootTarget;
  parentFor(entry: MountedSceneElement): SVGGElement;
}

interface PlacementContext {
  readonly dom: Pick<SceneDom, "group">;
  readonly placement?: SceneRootPlacement;
}

export function resolveSceneRootParent(
  entry: MountedSceneElement,
  context: PlacementContext,
): SVGGElement {
  const parent = context.placement?.parentFor(entry) ?? context.dom.group(entry.band);
  if (!context.dom.group(entry.band).contains(parent))
    throw new Error("Scene root placement must remain inside its render band.");
  return parent;
}

export function resolveSceneRootTarget(
  entry: MountedSceneElement,
  successor: MountedSceneElement | undefined,
  context: PlacementContext,
): SceneRootTarget {
  const target = context.placement?.placement(entry, successor) ?? {
    parent: context.dom.group(entry.band),
    before: successor === undefined ? null : firstPath(successor),
  };
  if (
    target.parent !== resolveSceneRootParent(entry, context) ||
    (target.before !== null && target.before.parentNode !== target.parent)
  )
    throw new Error("Scene root placement requires a direct anchor in its resolved parent.");
  return target;
}
