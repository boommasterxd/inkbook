import type { FontResourceV2, InkElementV1, TextStyleV2 } from "../../domain/schema/public";
import {
  assertFontResourceSelection,
  selectFontResources,
  type FontFaceRequest,
} from "./font-resources";
import { textRunFontResource } from "./bound-font-resources";
import { textFontFaceRequest } from "../../domain/text/font-face-matching";

/** Retain actual glyph and strut bindings, with snapshot-local resolution for legacy layouts. */
export function* usedFontResourcesSteps(
  elements: Iterable<InkElementV1>,
  resources: readonly FontResourceV2[],
): Generator<void, FontResourceV2[]> {
  const requests = new Map<string, FontFaceRequest>();
  const bound = new Map<string, FontResourceV2>();
  const add = (style: TextStyleV2): void => {
    const request = textFontFaceRequest(style);
    requests.set(`${request.family}:${request.weight}:${request.style}`, request);
  };
  for (const element of elements) {
    if (element.kind !== "text") continue;
    let hasTextRuns = false;
    for (const line of element.layout.lines) {
      for (const run of line.runs) {
        if (run.text.length > 0) {
          hasTextRuns = true;
          const resource = textRunFontResource(run, element.style, resources);
          bound.set(resource.id, resource);
        }
        yield;
      }
      yield;
    }
    const baseId = element.layout.baseFontResourceId;
    if (baseId !== undefined) {
      const baseFace = resources.find((face) => face.id === baseId);
      if (baseFace === undefined)
        throw new RangeError("The bound text strut font resource is unavailable.");
      bound.set(baseFace.id, baseFace);
    } else if (!hasTextRuns) add(element.style);
    yield;
  }
  for (const resource of selectFontResources(resources, [...requests.values()]))
    bound.set(resource.id, resource);
  const selected = [...bound.values()];
  assertFontResourceSelection(selected);
  return selected;
}
