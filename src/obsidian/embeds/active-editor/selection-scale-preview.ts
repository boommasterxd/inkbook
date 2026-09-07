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
  readonly #elements: ReadonlyMap<string, InkElementV1>;
  public readonly progressiveIds: readonly string[];

  public constructor(selected: readonly SelectedElementGeometry[]) {
    const elements = new Map<string, InkElementV1>();
    for (const { element } of selected) {
      elements.set(element.id, element);
    }
    this.#elements = elements;
    this.progressiveIds = [...elements.keys()];
  }

  public resolve(preview: SelectionHandlePreview): SelectionScalePreview {
    if (preview.transform?.kind !== "scale" || preview.exactPreviewTruncated) return EMPTY_PREVIEW;
    return {
      elements: preview.exactElements.filter(({ id }) => this.#elements.has(id)),
    };
  }

  public materializer(
    transform: (element: InkElementV1) => InkElementV1,
  ): (id: string) => InkElementV1 | undefined {
    return (id) => {
      const element = this.#elements.get(id);
      return element === undefined ? undefined : transform(element);
    };
  }
}
