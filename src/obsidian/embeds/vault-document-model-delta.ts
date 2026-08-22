import type { InkElementV1 } from "../../domain/schema/public";
import type { StoreDelta } from "../../domain/store/public";

export function changedElements(delta: StoreDelta): InkElementV1[] {
  return delta.changes.flatMap((change) =>
    change.after === null || !requiresFragmentReplacement(change.domains)
      ? []
      : [change.after.element as InkElementV1],
  );
}

export function removedElementIds(delta: StoreDelta): string[] {
  return delta.changes.filter((change) => change.after === null).map(({ id }) => id);
}

function requiresFragmentReplacement(domains: StoreDelta["changes"][number]["domains"]): boolean {
  return domains.some(
    (domain) => domain === "geometry" || domain === "paint" || domain === "connection",
  );
}
