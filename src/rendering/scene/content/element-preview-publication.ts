import { buildElementPathParts, type SvgPathPart } from "../../../domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../domain/geometry/stroke-position";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneElementRecord, MutableSceneInstrumentation } from "../types";
import type { SceneDom } from "../scene-dom";
import type { SceneSelectionRuns } from "../presentation/selection-runs";
import type { SceneSelectionTraces } from "../presentation/selection-traces";
import { updateMountedElementPreview, type MountedSceneElement } from "./mounted-element";
import type { ScenePathCache } from "./path-cache";
import { sameStrokeShape } from "./stroke-position";

interface PreviewPublicationContext {
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly selectionRuns: SceneSelectionRuns;
  readonly selectionTraces: SceneSelectionTraces;
  readonly onTextPublished?: (id: string) => void;
}

/** Publishes an already prepared preview while preserving canonical record versions. */
export function publish(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  element: InkElementV1,
  parts: readonly SvgPathPart[],
  context: PreviewPublicationContext,
): boolean {
  updateMountedElementPreview(entry, record, element, parts, {
    instrumentation: context.instrumentation,
    ownerDocument: context.dom.ownerDocument,
    parent: context.dom.group(entry.band),
  });
  context.selectionRuns.update(entry);
  if (entry.text !== undefined) context.onTextPublished?.(entry.id);
  return context.selectionTraces.update(entry, element, parts);
}

export function restoreParts(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  paths: ScenePathCache,
): readonly SvgPathPart[] | undefined {
  if (entry.geometryVersion === record.geometryVersion) return entry.pathParts;
  if (record.element.kind === "stroke" && record.element.style.pressureEnabled) return undefined;
  return paths.build(record.element);
}

export function elementParts(
  entry: MountedSceneElement,
  element: InkElementV1,
): readonly SvgPathPart[] {
  return sameStrokeShape(entry.displayedElement, element)
    ? entry.displayedPathParts
    : buildElementPathParts(element.kind === "stroke" ? strokeLocalGeometry(element) : element);
}
