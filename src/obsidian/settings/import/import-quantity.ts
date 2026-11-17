import type { Localization } from "../../../domain/localization";

export function quantity(
  count: number,
  noun: "handwriting" | "affectedNote" | "copy" | "file" | "note" | "conflict" | "original",
  localization: Localization,
): string {
  return localization.t(
    `import.quantity.${noun}.${localization.plural(count) === "one" ? "one" : "other"}`,
    { count: localization.number(count) },
  );
}
