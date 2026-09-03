import type { InkElementV1 } from "../../../domain/schema/public";
import type {
  SelectedElementGeometry,
  SelectionHandlePreview,
} from "../../../editor/selection/public";

export interface SelectionScalePreview {
  readonly elements: readonly InkElementV1[];
  readonly exactPreviewIds: ReadonlySet<string>;
}

export function selectionScalePreview(
  selected: readonly SelectedElementGeometry[],
  preview: SelectionHandlePreview,
): SelectionScalePreview {
  if (preview.transform?.kind !== "scale") return emptyScalePreview();
  const exactCandidates = new Set(
    selected
      .filter(({ element }) => requiresExactScaleGeometry(element))
      .map(({ element }) => element.id),
  );
  if (!preview.exactPreviewTruncated) {
    const elements = preview.exactElements.filter(({ id }) => exactCandidates.has(id));
    return { elements, exactPreviewIds: new Set(elements.map(({ id }) => id)) };
  }
  const elements = selected.flatMap(({ element }) =>
    element.kind === "stroke" && element.style.pressureEnabled
      ? [{ ...element, style: { ...element.style, pressureEnabled: false } }]
      : [],
  );
  return { elements, exactPreviewIds: new Set() };
}

function requiresExactScaleGeometry(element: InkElementV1): boolean {
  return (
    element.kind === "coordinate-system" ||
    element.kind === "arrow" ||
    (element.kind === "stroke" && element.style.pressureEnabled)
  );
}

function emptyScalePreview(): SelectionScalePreview {
  return { elements: [], exactPreviewIds: new Set() };
}
