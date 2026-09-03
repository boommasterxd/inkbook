import type { InkElementV1 } from "../../../domain/schema/public";
import type {
  SelectedElementGeometry,
  SelectionHandlePreview,
} from "../../../editor/selection/public";

export interface SelectionScalePreview {
  readonly elements: readonly InkElementV1[];
}

const EMPTY_PREVIEW: SelectionScalePreview = { elements: [] };

export class SelectionScalePreviewPlan {
  readonly #exactCandidateIds: ReadonlySet<string>;
  readonly #fallbackElements: readonly InkElementV1[];

  public constructor(selected: readonly SelectedElementGeometry[]) {
    const exactCandidateIds = new Set<string>();
    const fallbackElements: InkElementV1[] = [];
    for (const { element } of selected) {
      if (requiresExactScaleGeometry(element)) exactCandidateIds.add(element.id);
      if (element.kind === "stroke" && element.style.pressureEnabled) {
        fallbackElements.push({
          ...element,
          style: { ...element.style, pressureEnabled: false },
        });
      }
    }
    this.#exactCandidateIds = exactCandidateIds;
    this.#fallbackElements = fallbackElements;
  }

  public get exactCandidateIds(): ReadonlySet<string> {
    return this.#exactCandidateIds;
  }

  public resolve(preview: SelectionHandlePreview): SelectionScalePreview {
    if (preview.transform?.kind !== "scale") return EMPTY_PREVIEW;
    if (preview.exactPreviewTruncated) {
      return { elements: this.#fallbackElements };
    }
    return {
      elements: preview.exactElements.filter(({ id }) => this.#exactCandidateIds.has(id)),
    };
  }
}

function requiresExactScaleGeometry(element: InkElementV1): boolean {
  return (
    element.kind === "coordinate-system" ||
    element.kind === "arrow" ||
    (element.kind === "stroke" && element.style.pressureEnabled)
  );
}
