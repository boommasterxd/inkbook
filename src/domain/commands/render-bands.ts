import type { InkElementV1, StrokeElementV1 } from "../schema/types";

export const RENDER_BANDS = ["image", "highlight", "content"] as const;

export type RenderBand = (typeof RENDER_BANDS)[number];

export type RenderBandElement = Pick<InkElementV1, "kind"> & Partial<Pick<StrokeElementV1, "tool">>;

export interface DerivedRenderBands<T> {
  readonly image: readonly T[];
  readonly highlight: readonly T[];
  readonly content: readonly T[];
}

export function isHighlightElement(element: RenderBandElement): boolean {
  return renderBandOf(element) === "highlight";
}

export function renderBandOf(element: RenderBandElement): RenderBand {
  const kind = element.kind;
  if (kind === "image") return "image";
  return kind === "straight-highlighter" || (kind === "stroke" && element.tool === "highlighter")
    ? "highlight"
    : "content";
}

export function deriveRenderBands<T extends RenderBandElement>(
  elements: readonly T[],
): DerivedRenderBands<T> {
  const image: T[] = [];
  const highlight: T[] = [];
  const content: T[] = [];
  const bands = { image, highlight, content };

  for (const element of elements) {
    bands[renderBandOf(element)].push(element);
  }

  return bands;
}
