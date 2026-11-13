import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { SelectionScaleGesture } from "./selection-scale";
import type { ScaleFactors, TransformSliceScheduler } from "./transforms";
import type { SelectionHandlePreview } from "../handle-types";
import type { TextScaleCommitReflow } from "./text-scale-commit-reflow";

export function emptyHandlePreview(): SelectionHandlePreview {
  return {
    exactElements: [],
    exactPreviewTruncated: false,
    previewFrame: null,
    snapCandidate: null,
    snapGuide: null,
    transform: null,
  };
}

interface HandleMaterializationOptions {
  readonly elements: readonly InkElementV1[];
  readonly scale: SelectionScaleGesture | undefined;
  readonly pointer: PointV1;
  readonly uniformScale: boolean;
  readonly factors: ScaleFactors | undefined;
  readonly scheduler: TransformSliceScheduler;
  readonly materialize: (element: InkElementV1) => InkElementV1;
  readonly textReflow: TextScaleCommitReflow;
}

export async function materializeHandleTimeSliced(
  options: HandleMaterializationOptions,
): Promise<InkElementV1[] | null> {
  const { scheduler, scale } = options;
  const replacements: InkElementV1[] = [];
  for (const element of options.elements) {
    if (scheduler.isCancelled?.()) return null;
    let replacement =
      scale !== undefined && element.kind === "text"
        ? await scale.materializeOneTimeSliced(
            element,
            options.pointer,
            options.uniformScale,
            options.factors,
            scheduler,
          )
        : options.materialize(element);
    if (replacement === null || scheduler.isCancelled?.()) return null;
    if (scale !== undefined && replacement.kind === "text")
      replacement = await options.textReflow.prepare(replacement, scheduler);
    if (replacement === null || scheduler.isCancelled?.()) return null;
    replacements.push(replacement);
    if (scheduler.shouldYield()) {
      await scheduler.yieldControl();
      if (scheduler.isCancelled?.()) return null;
    }
  }
  if (scheduler.isCancelled?.()) return null;
  return scale === undefined
    ? replacements
    : scale.stabilizeAnchorTimeSliced(replacements, scheduler);
}
