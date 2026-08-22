import type { InkElementV1, StrokeElementV1 } from "../schema/types";

export type RenderBand = "highlight" | "content";

export type RenderBandElement = Pick<InkElementV1, "kind"> & Partial<Pick<StrokeElementV1, "tool">>;

export interface DerivedRenderBands<T> {
  readonly highlight: readonly T[];
  readonly content: readonly T[];
}

export function isHighlightElement(element: RenderBandElement): boolean {
  return (
    element.kind === "straight-highlighter" ||
    (element.kind === "stroke" && element.tool === "highlighter")
  );
}

export function renderBandOf(element: RenderBandElement): RenderBand {
  return isHighlightElement(element) ? "highlight" : "content";
}

export function deriveRenderBands<T extends RenderBandElement>(
  elements: readonly T[],
): DerivedRenderBands<T> {
  const highlight: T[] = [];
  const content: T[] = [];

  for (const element of elements) {
    (isHighlightElement(element) ? highlight : content).push(element);
  }

  return { highlight, content };
}
