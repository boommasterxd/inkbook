import type { InkElementV1 } from "../../../domain/schema/public";
import type {
  SelectedElementGeometry,
  SelectionHandlePreview,
} from "../../../editor/selection/public";

export interface SelectionScalePreview {
  readonly elements: readonly InkElementV1[];
  readonly pressurePreviewIds?: ReadonlySet<string>;
}

const EMPTY_PREVIEW: SelectionScalePreview = { elements: [] };

export class SelectionScalePreviewPlan {
  readonly #exactCandidateIds: ReadonlySet<string>;
  readonly #fallbackElements: readonly InkElementV1[];
  readonly #pressurePreviewIds: ReadonlySet<string>;

  public constructor(selected: readonly SelectedElementGeometry[]) {
    const exactCandidateIds = new Set<string>();
    const fallbackElements: InkElementV1[] = [];
    const pressurePreviewIds = new Set<string>();
    for (const { element } of selected) {
      if (requiresExactScaleGeometry(element)) exactCandidateIds.add(element.id);
      if (element.kind === "stroke" && element.style.pressureEnabled) {
        fallbackElements.push(element);
        pressurePreviewIds.add(element.id);
      }
    }
    this.#exactCandidateIds = exactCandidateIds;
    this.#fallbackElements = fallbackElements;
    this.#pressurePreviewIds = pressurePreviewIds;
  }

  public get exactCandidateIds(): ReadonlySet<string> {
    return this.#exactCandidateIds;
  }

  public resolve(preview: SelectionHandlePreview): SelectionScalePreview {
    if (preview.transform?.kind !== "scale") return EMPTY_PREVIEW;
    if (preview.exactPreviewTruncated) {
      return {
        elements: this.#fallbackElements,
        pressurePreviewIds: this.#pressurePreviewIds,
      };
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
