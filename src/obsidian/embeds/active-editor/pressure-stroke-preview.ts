import type { InkElementV1 } from "../../../domain/schema/public";
import type {
  SelectedElementGeometry,
  SelectionHandlePreview,
} from "../../../editor/selection/public";

export interface PressureStrokeScalePreview {
  readonly elements: readonly InkElementV1[];
  readonly exactPreviewIds: ReadonlySet<string>;
}

export function pressureStrokeScalePreview(
  selected: readonly SelectedElementGeometry[],
  pressureStrokeIds: ReadonlySet<string>,
  preview: SelectionHandlePreview,
): PressureStrokeScalePreview {
  if (preview.transform?.kind !== "scale" || pressureStrokeIds.size === 0) {
    return { elements: [], exactPreviewIds: new Set() };
  }
  if (!preview.exactPreviewTruncated) {
    const elements = preview.exactElements.filter(({ id }) => pressureStrokeIds.has(id));
    return { elements, exactPreviewIds: new Set(elements.map(({ id }) => id)) };
  }
  const elements = selected.flatMap(({ element }) =>
    pressureStrokeIds.has(element.id) && element.kind === "stroke"
      ? [{ ...element, style: { ...element.style, pressureEnabled: false } }]
      : [],
  );
  return { elements, exactPreviewIds: new Set() };
}
