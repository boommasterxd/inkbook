import type { InkElementV1 } from "../../../../domain/schema/public";
import type {
  SelectedElementGeometry,
  SelectionHandlePreview,
} from "../../../../editor/selection/public";

export interface SelectionScalePreview {
  readonly elements: readonly InkElementV1[];
}

const EMPTY_PREVIEW: SelectionScalePreview = { elements: [] };
const NO_TRANSFORM_IDS: readonly string[] = [];

export class SelectionScalePreviewPlan {
  readonly #elements: ReadonlyMap<string, InkElementV1>;
  readonly #textIds: readonly string[] | undefined;

  public constructor(selected: readonly SelectedElementGeometry[]) {
    const elements = new Map<string, InkElementV1>();
    for (const { element } of selected) {
      elements.set(element.id, element);
    }
    this.#elements = elements;
    this.#textIds =
      selected.length === 1 && selected[0]!.element.kind === "text"
        ? [selected[0]!.element.id]
        : undefined;
  }

  /** Pending native layout scales the retained group without rebuilding its editor. */
  public retainedTextIds(preview: SelectionHandlePreview): readonly string[] | undefined {
    return preview.transform?.kind === "scale" &&
      (preview.textScaleBasis !== undefined || preview.exactElements.length === 0)
      ? this.#textIds
      : undefined;
  }

  public transformIds(
    preview: SelectionHandlePreview,
    fallback: readonly string[],
  ): readonly string[] {
    return preview.transform?.kind === "scale"
      ? (this.retainedTextIds(preview) ?? NO_TRANSFORM_IDS)
      : fallback;
  }

  public resolve(preview: SelectionHandlePreview): SelectionScalePreview {
    if (preview.transform?.kind !== "scale" || preview.exactPreviewTruncated) return EMPTY_PREVIEW;
    return {
      elements: preview.exactElements.filter(
        (element) => element.kind !== "stroke" && this.#elements.has(element.id),
      ),
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
