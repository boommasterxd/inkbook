import type {
  CoordinateSystemElementV1,
  InkElementV1,
  TableElementV1,
} from "../../domain/schema/public";

export type MixedValue<T> = T | "mixed";

export type StructuralStyleSummary =
  | { readonly kind: "coordinate-system"; readonly dimension: MixedValue<"2d" | "3d"> }
  | { readonly kind: "table"; readonly columns: MixedValue<number> }
  | null;

function commonValue<T>(values: readonly T[]): MixedValue<T> {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : "mixed";
}

function allCoordinateSystems(
  elements: readonly InkElementV1[],
): elements is readonly CoordinateSystemElementV1[] {
  return elements.length > 0 && elements.every((element) => element.kind === "coordinate-system");
}

function allTables(elements: readonly InkElementV1[]): elements is readonly TableElementV1[] {
  return elements.length > 0 && elements.every((element) => element.kind === "table");
}

export function summarizeStructuralStyle(
  elements: readonly InkElementV1[],
): StructuralStyleSummary {
  if (allCoordinateSystems(elements)) {
    return {
      kind: "coordinate-system",
      dimension: commonValue(elements.map(({ dimension }) => dimension)),
    };
  }
  if (allTables(elements)) {
    return { kind: "table", columns: commonValue(elements.map(({ columns }) => columns)) };
  }
  return null;
}
