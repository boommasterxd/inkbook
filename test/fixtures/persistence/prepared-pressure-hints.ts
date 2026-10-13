import type { ElementStore } from "../../../src/domain/store/public";
import { preparedPressurePathHint } from "../../../src/persistence/serialization/prepared-pressure-hints";

/** Collect only the current bounded local paths accepted by the production producer. */
export function preparedHints(store: ElementStore, revision: number) {
  return Array.from(store.preparedPressurePaths()).flatMap(({ record, parts }) => {
    const hint = preparedPressurePathHint(record, parts, revision);
    return hint === undefined ? [] : [hint];
  });
}
