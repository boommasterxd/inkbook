import type { InkElementV1 } from "../schema/public";

import type { ElementMutation, ImmutableInkElement } from "./types";

export function mutationStructurePayloadBytes(mutation: ElementMutation): number {
  let bytes = ((mutation.bands?.content.length ?? 0) + (mutation.bands?.highlight.length ?? 0)) * 80;
  for (const placement of mutation.placements ?? []) bytes += placement.id.length * 2 + 24;
  for (const id of mutation.removeIds ?? []) bytes += id.length * 2;
  return bytes;
}

export function elementMutationPayloadBytes(element: InkElementV1 | ImmutableInkElement): number {
  const structuralBytes = 256 + element.id.length * 2;
  if (element.kind === "stroke") return structuralBytes + element.points.length * 8;
  if (element.kind === "coordinate-system") return structuralBytes + element.axes.length * 16;
  if (element.kind === "table") {
    return structuralBytes + (element.columnOffsets?.length ?? 0) * 8;
  }
  return structuralBytes;
}
