import {
  prepareTextPaintGeometrySteps,
  type TextPaintGeometry,
} from "../../geometry/text-paint-geometry";
import type { TextElementV2 } from "../../schema/public";
import type { ElementRecord } from "../types";

/** Field-local paint survives translation and rotation; persisted layout remains authoritative. */
export function* textRecordGeometrySteps(
  element: ElementRecord["element"],
  previous?: ElementRecord,
): Generator<void, { readonly textPaintGeometry?: TextPaintGeometry }> {
  if (element.kind !== "text") return {};
  if (
    previous?.element.kind === "text" &&
    previous.textPaintGeometry !== undefined &&
    sameLocalPaint(element, previous.element)
  )
    return { textPaintGeometry: previous.textPaintGeometry };
  return {
    textPaintGeometry: yield* prepareTextPaintGeometrySteps(element as TextElementV2),
  };
}

function sameLocalPaint(
  next: ElementRecord["element"] & { readonly kind: "text" },
  previous: ElementRecord["element"] & { readonly kind: "text" },
): boolean {
  return (
    next.layout === previous.layout &&
    next.ranges === previous.ranges &&
    next.source === previous.source &&
    next.width === previous.width &&
    next.height === previous.height &&
    next.style.fontSize === previous.style.fontSize &&
    next.style.opacity > 0 === previous.style.opacity > 0 &&
    next.style.underline === previous.style.underline &&
    next.style.strikethrough === previous.style.strikethrough &&
    visibleColor(next.style.color) === visibleColor(previous.style.color) &&
    visibleColor(next.backgroundColor) === visibleColor(previous.backgroundColor) &&
    next.backgroundOpacity > 0 === previous.backgroundOpacity > 0
  );
}

function visibleColor(color: TextElementV2["backgroundColor"]): boolean {
  return color !== null && (color.type === "theme-text" || color.value.slice(-2) !== "00");
}
