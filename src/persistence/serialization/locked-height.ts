import { derivePageExtent } from "../../domain/geometry/public";
import type { PageV1 } from "../../domain/schema/public";
import { serializeSvgNumber } from "../documents/svg-number";

export function isCanonicalLockedHeight(
  page: PageV1,
  maximumElementBottom: number | null,
  suppliedHeight: number,
): boolean {
  return (
    Number(serializeSvgNumber(derivePageExtent(page, maximumElementBottom).lockedHeight)) ===
    suppliedHeight
  );
}
