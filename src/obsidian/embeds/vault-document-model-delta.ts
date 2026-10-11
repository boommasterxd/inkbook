import type { ElementValidationDerivation, InkElementV1 } from "../../domain/schema/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../domain/spatial/index";
import type { StoreDelta } from "../../domain/store/public";

export function prepareVaultStoreDelta(delta: StoreDelta): {
  readonly changedElementDerivations: ElementValidationDerivation[];
  readonly changedElements: InkElementV1[];
  readonly removedIds: string[];
} {
  const changedElements: InkElementV1[] = [];
  const changedElementDerivations: ElementValidationDerivation[] = [];
  const removedIds: string[] = [];
  for (const change of delta.changes) {
    const after = change.after;
    if (after === null) {
      removedIds.push(change.id);
      continue;
    }
    if (!requiresFragmentReplacement(change.domains)) continue;
    const bounds = after.bounds;
    const spatialMemberships = spatialCellMembershipCount(bounds);
    const spatialOverflow = spatialMemberships > MAX_ELEMENT_CELLS;
    changedElements.push(after.element as InkElementV1);
    changedElementDerivations.push({
      bounds,
      elementId: change.id,
      spatialMemberships: spatialOverflow ? 0 : spatialMemberships,
      spatialOverflow,
    });
  }
  return { changedElementDerivations, changedElements, removedIds };
}

function requiresFragmentReplacement(domains: StoreDelta["changes"][number]["domains"]): boolean {
  return domains.some(
    (domain) => domain === "geometry" || domain === "paint" || domain === "connection",
  );
}
