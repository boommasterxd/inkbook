import type { ImageElementV3, InkSnapshotV1 } from "../../../domain/schema/public";
import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";
import { autoDefinitionsFragments } from "../output/auto-contrast-definitions";

/** Bind the contrast source to the same authoritative image order, crop and theme page. */
export function* matchesAutoDefinitionsSteps(
  snapshot: InkSnapshotV1,
  prelude: SafeSvgPrelude,
): Generator<void, boolean> {
  if (prelude.version < 5) return prelude.autoDefinitions === undefined;
  const supplied = prelude.autoDefinitions ?? "";
  const images: ImageElementV3[] = [];
  if ((snapshot.imageResources?.length ?? 0) > 0) {
    for (const element of snapshot.elements) {
      if (element.kind === "image") images.push(element);
      yield;
    }
  }
  let cursor = 0;
  for (const text of autoDefinitionsFragments(snapshot, prelude.lockedHeight, images)) {
    if (!supplied.startsWith(text, cursor)) return false;
    cursor += text.length;
    yield;
  }
  return cursor === supplied.length;
}
