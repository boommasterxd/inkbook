import type { SceneSelectionRuns } from "../presentation/selection-runs";
import type { SceneSelectionTraces } from "../presentation/selection-traces";
import type { ScenePublicationBudget } from "../reconciliation/mount-slice";
import type { MutableSceneInstrumentation, SceneStorePort } from "../types";
import { updateMountedPaint, type MountedSceneElement } from "./mounted-element";

interface PaintPublicationContext {
  readonly store: SceneStorePort;
  readonly mounted: ReadonlyMap<string, MountedSceneElement>;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly runs: SceneSelectionRuns;
  readonly traces: SceneSelectionTraces;
  readonly publication: ScenePublicationBudget;
  readonly deadline: number;
  readonly now: () => number;
  readonly onTextPublished: ((id: string) => void) | undefined;
  readonly markSelectionDirty: (id: string) => void;
}

/** Admits native rich-text paint through the same cooperative DOM builder as geometry. */
export function publishMountedPaint(id: string, context: PaintPublicationContext): boolean {
  const entry = context.mounted.get(id);
  const record = context.store.get(id);
  if (entry === undefined || record === undefined || entry.paintVersion === record.paintVersion)
    return true;
  if (
    record.element.kind === "text" &&
    entry.text?.prepare(record.element, context.deadline, context.now) === false
  )
    return false;
  updateMountedPaint(entry, record, entry.pathParts, context.instrumentation);
  if (entry.geometryVersion === record.geometryVersion) entry.displayedElement = record.element;
  context.runs.update(entry);
  if (!context.traces.update(entry, record.element, entry.displayedPathParts, context.publication))
    context.markSelectionDirty(entry.id);
  if (entry.text !== undefined) context.onTextPublished?.(entry.id);
  return true;
}
