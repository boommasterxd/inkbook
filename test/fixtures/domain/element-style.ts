import type { ImmutableInkElement } from "../../../src/domain/store/types";

/** A paint assertion must first establish that its selected element owns paint. */
export function readElementStyle(element: ImmutableInkElement | undefined) {
  if (element === undefined || element.kind === "image")
    throw new Error("Expected a styled element.");
  return element.style;
}
