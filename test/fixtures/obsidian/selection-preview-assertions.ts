import { expect } from "vitest";

import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";

export function expectLatestLinePreview(
  previews: readonly (readonly InkElementV1[])[],
  id: string,
  expectedStart: PointV1,
): void {
  const current = previews[previews.length - 1] ?? [];
  const dependent = current.find((element) => element.id === id);
  expect(dependent?.kind).toBe("line");
  if (dependent?.kind !== "line") throw new TypeError("Expected a line preview.");
  expect(dependent.start).toEqual(expectedStart);
}
