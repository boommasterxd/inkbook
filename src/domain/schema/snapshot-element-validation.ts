import { isHighlightElement } from "../commands/render-bands";
import { assertInkElementSteps } from "./element-validation";
import { assertImageBinding } from "./image-validation";
import { fail, type ValidationContext } from "./validation-internals";
import type { ImageResourceV3, InkElementV1 } from "./types";
import { hasMeasuredTextInkBounds } from "./snapshot-version";

/** Resource bindings and ordering share the existing element validation traversal. */
export function* validateSnapshotElementsSteps(
  elements: unknown[],
  context: ValidationContext,
  version: number,
  resources: readonly ImageResourceV3[],
): Generator<void, void> {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  let previousBand = 0;
  for (let index = 0; index < elements.length; index += 1) {
    const path = `$.elements[${index}]`;
    const element = elements[index];
    yield* assertInkElementSteps(element, path, context);
    const validated = element as InkElementV1;
    assertElementVersion(validated, version);
    if (validated.kind === "image")
      assertImageBinding(validated, byId.get(validated.assetId), index);
    const band = validated.kind === "image" ? 0 : isHighlightElement(validated) ? 1 : 2;
    if (band < previousBand)
      fail("invalid-render-band-order", path, "Images must precede highlights and content.");
    previousBand = band;
    yield;
  }
}

function assertElementVersion(element: InkElementV1, version: number): void {
  if (version < 4 && element.locked === true)
    fail("invalid-literal", "$.version", "Locked elements require snapshot version 4.");
  if (version === 1 && element.kind === "text")
    fail("invalid-literal", "$.version", "Text elements require snapshot version 2.");
  if (version < 5 && hasMeasuredTextInkBounds(element))
    fail("invalid-literal", "$.version", "Measured text ink bounds require snapshot version 5.");
  if (element.kind !== "image") return;
  if (version < 3)
    fail("invalid-literal", "$.version", "Image elements require snapshot version 3.");
}
