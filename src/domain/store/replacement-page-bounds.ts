import { getCanonicalStrokeReplacementProof } from "../elements/stroke-replacement-proof";
import { calculateElementBounds, isWithinPageBounds, PAGE_WIDTH } from "../geometry/public";
import type { InkElementV1 } from "../schema/public";

import type { ElementRecord } from "./types";

export function assertReplacementPageBoundsWhenSourceWasValid(
  drafts: ReadonlyMap<string, InkElementV1>,
  getRecord: (id: string) => ElementRecord,
): void {
  for (const id of drafts.keys()) {
    if (!isWithinPageBounds(getRecord(id).bounds)) return;
  }
  for (const [id, draft] of drafts) {
    const current = getRecord(id);
    if (!replacementWithinPage(current, draft)) {
      throw new RangeError("Conservative element bounds must remain within the supported page.");
    }
  }
}

function replacementWithinPage(current: ElementRecord, replacement: InkElementV1): boolean {
  if (current.element.kind !== "stroke" || replacement.kind !== "stroke") {
    return isWithinPageBounds(calculateElementBounds(replacement));
  }
  const proof = getCanonicalStrokeReplacementProof(replacement);
  if (proof?.source !== current.element) {
    return isWithinPageBounds(calculateElementBounds(replacement));
  }
  return (
    current.bounds.minX + proof.translation.x >= 0 &&
    current.bounds.maxX + proof.translation.x <= PAGE_WIDTH &&
    current.bounds.minY + proof.translation.y >= 0
  );
}
