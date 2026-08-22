import type { InkElementV1 } from "../schema/public";

import type { ElementMutation, ImmutableInkElement } from "./types";

export function mutationStructurePayloadBytes(mutation: ElementMutation): number {
  let bytes = (mutation.bands.content.length + mutation.bands.highlight.length) * 80;
  for (const id of mutation.removeIds ?? []) bytes += id.length * 2;
  return bytes;
}

export function elementMutationPayloadBytes(element: InkElementV1 | ImmutableInkElement): number {
  const structuralBytes = 256 + element.id.length * 2;
  if (element.kind === "stroke") return structuralBytes + element.points.length * 8;
  if (element.kind === "coordinate-system") return structuralBytes + element.axes.length * 16;
  return structuralBytes;
}
