import type { RenderBand } from "../commands/render-bands";

import { mutableElement } from "./immutability";
import { elementMutationPayloadBytes, mutationStructurePayloadBytes } from "./mutation-payload";
import type { AppliedElementMutation, ElementMutation, StoreDelta } from "./types";

export function createRemovalTransition(
  delta: StoreDelta,
  beforeBands: Readonly<Record<RenderBand, readonly string[]>>,
  afterBands: Readonly<Record<RenderBand, readonly string[]>>,
): AppliedElementMutation {
  const forward = mutationFromDelta(delta, afterBands, "forward");
  const reverse = mutationFromDelta(delta, beforeBands, "reverse");
  return Object.freeze({
    forward,
    payloadBytes: estimatePayloadBytes(forward) + estimatePayloadBytes(reverse),
    reverse,
  });
}

function mutationFromDelta(
  delta: StoreDelta,
  bands: Readonly<Record<RenderBand, readonly string[]>>,
  direction: "forward" | "reverse",
): ElementMutation {
  const elements = [];
  const removeIds: string[] = [];
  for (const change of delta.changes) {
    const source = direction === "forward" ? change.before : change.after;
    const destination = direction === "forward" ? change.after : change.before;
    if (destination === null) {
      if (source !== null) removeIds.push(change.id);
      continue;
    }
    // Redo derives the same detachments atomically from removed targets.
    if (direction === "forward") continue;
    if (source?.element !== destination.element) {
      elements.push(mutableElement(destination.element));
    }
  }
  return Object.freeze({
    bands: Object.freeze({
      content: Object.freeze([...bands.content]),
      highlight: Object.freeze([...bands.highlight]),
    }),
    elements: Object.freeze(elements),
    removeIds: Object.freeze(removeIds),
  });
}

function estimatePayloadBytes(mutation: ElementMutation): number {
  return (
    mutationStructurePayloadBytes(mutation) +
    (mutation.elements ?? []).reduce(
      (bytes, element) => bytes + elementMutationPayloadBytes(element),
      0,
    )
  );
}
