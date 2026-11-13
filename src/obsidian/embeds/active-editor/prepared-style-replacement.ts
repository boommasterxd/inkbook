import type { InkElementV1 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TransformSliceScheduler } from "../../../editor/selection/transform/transforms";
import type { TextReflow } from "../../../editor/selection/transform/text-reflow-session";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { createSelectionStyleReplacementSteps } from "./controller-styles";
import type { SelectedElementGeometry } from "../../../editor/selection/public";

export interface StyleReplacementRequest {
  readonly selection: ReadonlySet<string>;
  readonly controlId: string;
  readonly value: boolean | number | string;
  readonly isCurrent: () => boolean;
}

export interface PreparedStyleReplacement {
  readonly previous: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
  readonly changed: boolean;
  readonly selected: readonly SelectedElementGeometry[];
  readonly mutationVersion: number;
  readonly revision: number;
}

/** Shared preparation for local slider feedback and its one authoritative commit. */
export async function prepareStyleReplacement(
  request: StyleReplacementRequest,
  options: {
    readonly model: EditableDocumentModel;
    readonly reflow: TextReflow | undefined;
    readonly scheduler: WorkScheduler;
    readonly signal: AbortSignal;
    readonly isCancelled: () => boolean;
  },
): Promise<PreparedStyleReplacement | null> {
  const { model, signal } = options;
  let revision = model.revision;
  const mutationVersion = model.store.mutationVersion;
  const cancelled = () =>
    signal.aborted ||
    options.isCancelled() ||
    !request.isCurrent() ||
    model.revision !== revision ||
    model.store.mutationVersion !== mutationVersion;
  const scheduler: TransformSliceScheduler = {
    isCancelled: cancelled,
    shouldYield: () => options.scheduler.shouldYield(),
    yieldControl: () => options.scheduler.checkpoint(signal, "frame") ?? Promise.resolve(),
  };
  const previous: InkElementV1[] = [];
  const geometry: SelectedElementGeometry[] = [];
  function* selected() {
    for (const id of request.selection) {
      const record = model.store.get(id);
      if (!record) throw new RangeError("Style selection is stale.");
      previous.push(record.element as InkElementV1);
      geometry.push({ element: record.element as InkElementV1, bounds: record.bounds });
      yield record.element as InkElementV1;
    }
  }
  const steps = createSelectionStyleReplacementSteps(selected(), request.controlId, request.value);
  let step: ReturnType<typeof steps.next>;
  do {
    if (cancelled()) return null;
    if (scheduler.shouldYield()) await scheduler.yieldControl();
    if (cancelled()) return null;
    step = steps.next();
  } while (!step.done);
  const replacements: InkElementV1[] = [];
  for (const [index, element] of (step.value?.replacements ?? previous).entries()) {
    if (cancelled()) return null;
    replacements.push(
      element.kind === "text" && element !== previous[index] && options.reflow
        ? await options.reflow(element, signal)
        : element,
    );
    if (model.store.mutationVersion !== mutationVersion) return null;
    revision = model.revision;
  }
  return cancelled()
    ? null
    : {
        previous,
        replacements,
        selected: geometry,
        changed: step.value !== null,
        revision,
        mutationVersion,
      };
}
