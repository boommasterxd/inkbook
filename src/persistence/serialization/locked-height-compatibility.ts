import { deriveLegacyLockedHeight, derivePageExtent } from "../../domain/geometry/public";
import type { PageV1 } from "../../domain/schema/public";
import { serializeSvgNumber } from "../documents/svg-number";

export function isSupportedLockedHeight(
  page: PageV1,
  maximumElementBottom: number | null,
  suppliedHeight: number,
): boolean {
  return (
    canonicalNumber(derivePageExtent(page, maximumElementBottom).lockedHeight) === suppliedHeight ||
    canonicalNumber(deriveLegacyLockedHeight(page, maximumElementBottom)) === suppliedHeight
  );
}

function canonicalNumber(value: number): number {
  return Number(serializeSvgNumber(value));
}
