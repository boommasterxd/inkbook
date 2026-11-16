import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "./svg-output-limits";
import { hasExactAttributes, parseOpeningTag } from "./svg-tag";
import { validStrokeGroupAttributes } from "./safe-svg-transform";

export interface SvgTotals {
  commands: number;
  groups: number;
  pathBytes: number;
  paths: number;
  textElements?: number;
  unadjustedTextRuns?: number;
}

export function validPressureGroup(
  tag: NonNullable<ReturnType<typeof parseOpeningTag>>,
  id: string,
  pressurePaths: number | null,
  totals: SvgTotals,
): boolean {
  if (
    id === "inkbook-background" ||
    pressurePaths !== null ||
    tag.selfClosing ||
    !validStrokeGroupAttributes(tag.attributes)
  )
    return false;
  totals.groups += 1;
  return totals.groups <= FILE_SCHEMA_LIMITS.elements;
}

export function accountPath(totals: SvgTotals, commands: number, pathData: string): boolean {
  totals.paths += 1;
  totals.commands += commands;
  totals.pathBytes += pathData.length;
  return (
    totals.paths <= 60_004 &&
    totals.commands <= 8_000_000 &&
    totals.pathBytes <= MAXIMUM_TOTAL_PATH_DATA_BYTES
  );
}

export function isBandGroup(tag: ReturnType<typeof parseOpeningTag>, id: string): boolean {
  return (
    tag !== null &&
    tag.name === "g" &&
    !tag.selfClosing &&
    hasExactAttributes(tag.attributes, { id })
  );
}
