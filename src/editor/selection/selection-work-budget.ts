import type { InkElementV1 } from "../../domain/schema/public";

export interface SelectionReplacementPlanner {
  countReverseDependencies(targetIds: readonly string[], limit: number): number;
  planReplacements(replacements: readonly InkElementV1[]): SelectionReplacementPlan | null;
  planReplacementsTimeSliced(
    replacements: readonly InkElementV1[],
    scheduler: SelectionReplacementSliceScheduler,
  ): Promise<SelectionReplacementPlan | "cancelled" | null>;
}

interface SelectionReplacementPlan {
  readonly elements: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
}

interface SelectionReplacementSliceScheduler {
  readonly isCancelled?: () => boolean;
  readonly shouldYield: () => boolean;
  readonly yieldControl: () => Promise<void>;
}

const EXACT_PREVIEW_ELEMENT_LIMIT = 256;
const EXACT_PREVIEW_WORK_LIMIT = 16_384;
const EXACT_STROKE_PREVIEW_POINT_LIMIT = 256;

/** Linear replacements consume one geometry-work unit each, without stroke samples. */
export function exceedsExactLinearPreviewWork(elementCount: number): boolean {
  return elementCount > Math.min(EXACT_PREVIEW_ELEMENT_LIMIT, EXACT_PREVIEW_WORK_LIMIT);
}

export function exceedsExactPreviewWork(
  elements: readonly InkElementV1[],
  planner: SelectionReplacementPlanner,
  options: ReplacementWorkOptions = {},
): boolean {
  if (hasLongStroke(elements)) return true;
  return exceedsReplacementWork(
    elements,
    planner,
    EXACT_PREVIEW_ELEMENT_LIMIT,
    EXACT_PREVIEW_WORK_LIMIT,
    options,
  );
}

function hasLongStroke(elements: readonly InkElementV1[]): boolean {
  return elements.some(
    (element) =>
      element.kind === "stroke" && element.points.length / 3 > EXACT_STROKE_PREVIEW_POINT_LIMIT,
  );
}

export interface ReplacementWorkOptions {
  readonly countStrokeSamples?: boolean;
  readonly includeReverseDependencies?: boolean;
  readonly hasLinearConnectionTarget?: boolean;
}

export function exceedsReplacementWork(
  elements: readonly InkElementV1[],
  planner: SelectionReplacementPlanner,
  elementLimit: number,
  workLimit: number,
  options: ReplacementWorkOptions = {},
): boolean {
  if (elements.length > elementLimit) return true;
  // A linear target may reach the complete connection graph even without dependents.
  if (options.hasLinearConnectionTarget || hasLinearConnectionDependencies(elements)) return true;
  let work = 0;
  for (const element of elements) {
    work +=
      element.kind === "stroke" && options.countStrokeSamples !== false
        ? element.points.length / 3
        : 1;
    if (work > workLimit) return true;
  }
  if (options.includeReverseDependencies === false) return false;
  const dependencyLimit = Math.min(elementLimit - elements.length, workLimit - work);
  const targetIds = elements.map(({ id }) => id);
  return planner.countReverseDependencies(targetIds, dependencyLimit) > dependencyLimit;
}

export function hasLinearConnectionDependencies(elements: readonly InkElementV1[]): boolean {
  return elements.some(hasLinearConnectionTarget);
}

function hasLinearConnectionTarget(element: InkElementV1): boolean {
  return (
    (element.kind === "line" || element.kind === "arrow") &&
    (element.startConnection?.anchor.kind === "linear-endpoint" ||
      element.endConnection?.anchor.kind === "linear-endpoint")
  );
}
