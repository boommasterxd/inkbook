import type { ElementValidationDerivation, InkElementV1 } from "../../domain/schema/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../domain/spatial/index";
import type { StoreDelta } from "../../domain/store/public";

export function changedElements(delta: StoreDelta): InkElementV1[] {
  return delta.changes.flatMap((change) =>
    change.after === null || !requiresFragmentReplacement(change.domains)
      ? []
      : [change.after.element as InkElementV1],
  );
}

export function changedElementDerivations(delta: StoreDelta): ElementValidationDerivation[] {
  return delta.changes.flatMap((change) => {
    if (change.after === null || !requiresFragmentReplacement(change.domains)) return [];
    const spatialMemberships = spatialCellMembershipCount(change.after.bounds);
    const spatialOverflow = spatialMemberships > MAX_ELEMENT_CELLS;
    return [
      {
        bounds: change.after.bounds,
        elementId: change.id,
        spatialMemberships: spatialOverflow ? 0 : spatialMemberships,
        spatialOverflow,
      },
    ];
  });
}

export function removedElementIds(delta: StoreDelta): string[] {
  return delta.changes.filter((change) => change.after === null).map(({ id }) => id);
}

function requiresFragmentReplacement(domains: StoreDelta["changes"][number]["domains"]): boolean {
  return domains.some(
    (domain) => domain === "geometry" || domain === "paint" || domain === "connection",
  );
}
