import type { ScrollDocumentPort, ScrollMetricsPort } from "./scroll-ports";

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll"]);

export function resolveScrollOwner<ElementType>(
  start: ElementType,
  document: ScrollDocumentPort<ElementType>,
  metrics: ScrollMetricsPort<ElementType>,
): ElementType | null {
  let candidate = document.getParent(start);
  let nearestEligible: ElementType | null = null;

  while (candidate !== null) {
    if (SCROLLABLE_OVERFLOW.has(document.getOverflowY(candidate))) {
      nearestEligible ??= candidate;
      if (metrics.getScrollHeight(candidate) > metrics.getClientHeight(candidate)) {
        return candidate;
      }
    }
    candidate = document.getParent(candidate);
  }

  return nearestEligible ?? document.scrollingElement;
}
