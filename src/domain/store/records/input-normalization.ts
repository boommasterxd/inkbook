import type { InkElementV1 } from "../../schema/public";

export function normalizeElementInput(
  value: InkElementV1 | readonly InkElementV1[],
): readonly InkElementV1[] {
  return isElementList(value) ? value : [value];
}

export function normalizeIdInput(
  value: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  return isIdList(value) ? new Set(value) : value;
}

function isElementList(
  value: InkElementV1 | readonly InkElementV1[],
): value is readonly InkElementV1[] {
  return Array.isArray(value);
}

function isIdList(value: ReadonlySet<string> | readonly string[]): value is readonly string[] {
  return Array.isArray(value);
}
