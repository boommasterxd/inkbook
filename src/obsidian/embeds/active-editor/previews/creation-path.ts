import { buildElementPathParts } from "../../../../domain/geometry/public";
import type { InkElementV1 } from "../../../../domain/schema/public";
import { pathPresentation } from "../../../../rendering/scene/content/element-presentation";
import type { LivePathState } from "../../../../rendering/scene/index";

export function creationLivePath(element: InkElementV1, opacity = 1): LivePathState {
  return {
    band: element.kind === "straight-highlighter" ? "highlight" : "content",
    parts: buildElementPathParts(element).map((part) => {
      const presentation = pathPresentation(element, part);
      if (opacity === 1) return { d: part.d, presentation };
      return {
        d: part.d,
        presentation: {
          ...presentation,
          "fill-opacity": String(Number(presentation["fill-opacity"] ?? 1) * opacity),
          "stroke-opacity": String(Number(presentation["stroke-opacity"] ?? 1) * opacity),
        },
      };
    }),
  };
}
