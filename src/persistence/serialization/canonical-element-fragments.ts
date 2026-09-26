import type { InkElementV1 } from "../../domain/schema/public";
import { canonicalElement } from "./canonical-snapshot";

/** Avoid materializing or stringifying an entire long runtime stroke in one task. */
export function* canonicalElementFragments(element: InkElementV1): Iterable<string> {
  if (element.kind !== "stroke") {
    yield JSON.stringify(canonicalElement(element));
    return;
  }
  const canonical = canonicalElement({ ...element, points: [] });
  const template = JSON.stringify(canonical);
  const marker = '"points":[]';
  const offset = template.indexOf(marker) + marker.length - 1;
  yield template.slice(0, offset);
  for (let start = 0; start < element.points.length; start += 1024) {
    const end = Math.min(start + 1024, element.points.length);
    const numbers: string[] = [];
    for (let index = start; index < end; index += 1) {
      numbers.push(JSON.stringify(element.points[index]));
    }
    yield (start === 0 ? "" : ",") + numbers.join(",");
  }
  yield template.slice(offset);
}
